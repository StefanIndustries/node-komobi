import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig, Method } from "axios";
import { KomobiOptions } from "./komobi-options";
import { Aggregation, apiKey, defaultBaseURL, Endpoints, pool, userAgent } from "./constants";
import { KomobiLoginError } from "./classes/komobi-login-error";
import { Authenticator, CognitoAuthenticator } from "./classes/cognito-authenticator";
import { KomobiSession } from "./models/komobi-session";
import { KomobiRoute, KomobiUser, KomobiVehicle } from "./models/komobi-models";
import { routesTransformer, unwrapItems, userTransformer, vehicleTransformer } from "./transformers";

export { KomobiOptions } from "./komobi-options";
export { KomobiLoginError } from "./classes/komobi-login-error";
export { KomobiSession } from "./models/komobi-session";
export { Endpoints, Aggregation } from "./constants";
export * from "./models/komobi-models";

type RetriableConfig = InternalAxiosRequestConfig & { komobiAuthRetried?: boolean };

/** Refresh this long before the ID token expires, so a request does not race the expiry. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/** Options for the ride history endpoint. */
export interface HistoryQuery {
    from?: Date;
    to?: Date;
    /** Day boundaries are evaluated in this IANA time zone; defaults to the client's timeZone option. */
    timeZone?: string;
}

export class Komobi {
    public session: KomobiSession | undefined = undefined;
    private readonly ax: AxiosInstance;
    private readonly auth: Authenticator;
    private readonly timeZone: string;
    private abortController = new AbortController();
    /** Shared while a login/refresh is running, so parallel requests authenticate only once. */
    private pendingAuth: Promise<KomobiSession> | undefined = undefined;
    /** The account's internal fleet id, resolved once from the user record and cached. */
    private userFleetId: string | undefined = undefined;

    constructor(private options: KomobiOptions) {
        this.auth = new CognitoAuthenticator(options.email, options.password);
        this.timeZone = options.timeZone ?? 'UTC';
        this.ax = axios.create({
            baseURL: options.baseURL ?? defaultBaseURL,
            timeout: options.timeout ?? 15000,
            signal: this.abortController.signal,
            headers: {
                'User-Agent': userAgent,
                'Accept': 'application/json',
            },
        });

        this.ax.interceptors.request.use((config) => {
            if (this.session) {
                config.headers['Authorization'] = this.session.idToken;
            }
            return config;
        });

        this.ax.interceptors.response.use(undefined, async (error: AxiosError) => {
            const config = error.config as RetriableConfig | undefined;
            const status = error.response?.status;
            if ((status !== 401 && status !== 403) || !config) {
                throw error;
            }
            // Re-authenticate and retry once; a second rejection means the account has no access.
            if (config.komobiAuthRetried) {
                throw new KomobiLoginError(`Komobi kept rejecting ${config.url} after logging in again.`, status);
            }
            config.komobiAuthRetried = true;
            await this.reauthenticate();
            return this.ax.request(config);
        });
    }

    /**
     * Logs in with the configured e-mail and password. Called automatically before the first
     * request, so calling it yourself is only needed to check the credentials up front.
     */
    public async login(): Promise<KomobiSession> {
        return this.authenticate(() => this.auth.login());
    }

    /**
     * The current user's record. Looked up by the account e-mail (that is what the API expects as
     * `userId`, not the Cognito id). Contains the internal fleet id used by the vehicle endpoints.
     */
    public async getUser(): Promise<KomobiUser> {
        await this.ensureSession();
        const data = await this.send('GET', Endpoints.user, { userId: this.options.email });
        return userTransformer(data);
    }

    /**
     * Whether Komobi has provisioned this Cognito account (checked with the app's API key).
     * True right after sign-up, even for an account that has no vehicle yet.
     */
    public async accountExists(): Promise<boolean> {
        const session = await this.ensureSession();
        const result = await this.send('GET', Endpoints.user, { id: session.userSub, pool }, undefined, { 'x-api-key': apiKey }) as { exists?: boolean };
        return result?.exists === true;
    }

    /** Resolves and caches the internal fleet id for this account, which the vehicle endpoints need. */
    public async getUserFleetId(): Promise<string> {
        if (this.userFleetId) {
            return this.userFleetId;
        }
        const fleetId = (await this.getUser()).userFleetId;
        if (!fleetId) {
            throw new KomobiLoginError('Could not resolve a fleet id for this account; it has no vehicle registered in Komobi yet.');
        }
        this.userFleetId = fleetId;
        return fleetId;
    }

    /** All vehicles on the account, with their tracker status and last known position. */
    public async getVehicles(locale = 'en'): Promise<KomobiVehicle[]> {
        const userFleetId = await this.getUserFleetId();
        const data = await this.request('GET', Endpoints.vehicles, { userFleetId, expandedInfo: 'true', locale });
        return unwrapItems(data).map(vehicleTransformer);
    }

    /** A single vehicle with its tracker status and last known position. */
    public async getVehicle(vehicleId: string, locale = 'en'): Promise<KomobiVehicle> {
        const data = await this.request('GET', Endpoints.vehicle(vehicleId), { expandedInfo: 'true', locale });
        return vehicleTransformer(Array.isArray(data) ? data[0] : (data as { items?: unknown[] })?.items?.[0] ?? data);
    }

    /** Ride history of a vehicle, newest first. Defaults to the last 30 days. */
    public async getRoutes(vehicleId: string, query: HistoryQuery = {}): Promise<KomobiRoute[]> {
        const data = await this.request('GET', Endpoints.routes, { vehicleId, ...this.rangeParams(query) });
        return routesTransformer(data);
    }

    /** Raw ride history grouped by day, as returned by the API (for callers that need the envelope). */
    public async getRoutesRaw(vehicleId: string, query: HistoryQuery = {}): Promise<unknown> {
        return this.request('GET', Endpoints.routes, { vehicleId, ...this.rangeParams(query) });
    }

    /** Raw detail of a single ride. */
    public async getRouteDetail(vehicleId: string, routeId: string | number): Promise<unknown> {
        return this.request('GET', Endpoints.routeDetail(vehicleId, String(routeId)));
    }

    /** Raw GPS track of a single ride. */
    public async getRouteGps(vehicleId: string, routeId: string | number): Promise<unknown> {
        return this.request('GET', Endpoints.routeGps(vehicleId, String(routeId)));
    }

    /** Raw theft-alarm history of a vehicle. */
    public async getAlarms(vehicleId: string, query: HistoryQuery = {}): Promise<unknown> {
        return this.request('GET', Endpoints.alarms, { vehicleId, ...this.rangeParams(query) });
    }

    /** Raw maintenance info: remaining kilometers to oil, tyre and brake service, and inspection dates. */
    public async getMaintenance(vehicleId: string): Promise<unknown> {
        return this.request('GET', Endpoints.maintenance(vehicleId));
    }

    /** Raw riding statistics for the current user over a period. */
    public async getStats(query: HistoryQuery & { indicator?: string, aggregation?: Aggregation, vehicleId?: string } = {}): Promise<unknown> {
        const session = await this.ensureSession();
        return this.send('GET', Endpoints.userStats(session.userSub), {
            ...this.rangeParams(query),
            aggregation: (query.aggregation ?? 'MONTH'),
            ...(query.indicator ? { indicator: query.indicator } : {}),
            ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
        });
    }

    /** Raw tracker status by device id: battery, connectivity and last known position. */
    public async getDevice(deviceId: string): Promise<unknown> {
        return this.request('GET', Endpoints.device(deviceId));
    }

    /**
     * Sends an authenticated request to any API path, for endpoints this package does not wrap yet.
     */
    public async request<T = unknown>(method: Method, path: string, params?: Record<string, string>, data?: unknown): Promise<T> {
        await this.ensureSession();
        return this.send<T>(method, path, params, data);
    }

    /** Sends a request assuming the session is already current; the auth interceptor still refreshes on a 401. */
    private async send<T = unknown>(method: Method, path: string, params?: Record<string, string>, data?: unknown, headers?: Record<string, string>): Promise<T> {
        const response = await this.ax.request<T>({ method, url: path, params, data, headers });
        return response.data;
    }

    /** Aborts running requests and forgets the session. Create a new instance afterwards. */
    public dispose(): void {
        this.abortController.abort();
        this.session = undefined;
        this.userFleetId = undefined;
    }

    /**
     * Builds the query the routes/alarms endpoints expect: day-aggregated, bounded by `endDate`
     * (unix seconds, 0 = now) and `aggregationLimitTo` days back, with an optional `startDate`.
     */
    private rangeParams(query: HistoryQuery): Record<string, string> {
        const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));
        const to = query.to ?? new Date();
        const days = query.from
            ? Math.max(1, Math.ceil((to.getTime() - query.from.getTime()) / 86400000))
            : 30;
        const params: Record<string, string> = {
            aggregation: 'day',
            aggregationLimitTo: String(days),
            endDate: query.to ? unix(query.to) : '0',
            timeZone: query.timeZone ?? this.timeZone,
        };
        if (query.from) {
            params.startDate = unix(query.from);
        }
        return params;
    }

    private async ensureSession(): Promise<KomobiSession> {
        if (!this.session) {
            return this.login();
        }
        if (this.session.expiresAt.getTime() - EXPIRY_MARGIN_MS < Date.now()) {
            return this.reauthenticate();
        }
        return this.session;
    }

    /** Refreshes the session when there is one, falling back to a full login. */
    private async reauthenticate(): Promise<KomobiSession> {
        const hadSession = this.session !== undefined;
        return this.authenticate(async () => {
            if (hadSession) {
                try {
                    return await this.auth.refresh();
                } catch {
                    // Refresh token expired or revoked, or another account is signed in; log in from scratch.
                }
            }
            return this.auth.login();
        });
    }

    private authenticate(run: () => Promise<KomobiSession>): Promise<KomobiSession> {
        if (!this.pendingAuth) {
            this.session = undefined;
            this.pendingAuth = run()
                .then((session) => {
                    this.session = session;
                    return session;
                })
                .finally(() => {
                    this.pendingAuth = undefined;
                });
        }
        return this.pendingAuth;
    }
}
