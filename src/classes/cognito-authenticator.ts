import axios, { AxiosInstance } from "axios";
import { cognito, userAgent } from "../constants";
import { KomobiSession } from "../models/komobi-session";
import { KomobiLoginError } from "./komobi-login-error";
import {
    cognitoTimestamp, createClientKeys, deviceSecretVerifier, passwordAuthenticationKey, passwordClaimSignature, toBigInt
} from "./cognito-srp";

/** Cognito errors meaning the e-mail address or password is not accepted. */
const CREDENTIAL_ERRORS = ['NotAuthorizedException', 'UserNotFoundException', 'UserNotConfirmedException', 'PasswordResetRequiredException'];

export interface Authenticator {
    login(): Promise<KomobiSession>;
    /** Refreshes the current session; rejects when it can not, so the caller can log in again. */
    refresh(): Promise<KomobiSession>;
}

interface AuthenticationResult {
    IdToken?: string;
    AccessToken?: string;
    RefreshToken?: string;
    /** Sent when the user pool tracks devices; the refresh token then only works together with this device key. */
    NewDeviceMetadata?: { DeviceKey?: string, DeviceGroupKey?: string };
}

interface CognitoResponse {
    ChallengeName?: string;
    ChallengeParameters?: Record<string, string>;
    Session?: string;
    AuthenticationResult?: AuthenticationResult;
}

/**
 * Logs in to the Komobi Cognito user pool the same way the app does (SRP, so the password never leaves this
 * machine), by calling the Cognito user pool API directly. Each instance keeps its own refresh token, so several
 * accounts can be signed in at the same time.
 */
export class CognitoAuthenticator implements Authenticator {
    private refreshToken: string | undefined;
    /** Key of the confirmed device the refresh token is bound to. */
    private deviceKey: string | undefined;
    private readonly http: AxiosInstance;

    constructor(private email: string, private password: string, timeout = 15000) {
        this.http = axios.create({
            baseURL: `https://cognito-idp.${cognito.region}.amazonaws.com/`,
            timeout,
            headers: { 'Content-Type': 'application/x-amz-json-1.1', 'User-Agent': userAgent },
        });
    }

    public async login(): Promise<KomobiSession> {
        const { a, A } = createClientKeys();
        const challenge = await this.call('InitiateAuth', {
            AuthFlow: 'USER_SRP_AUTH',
            ClientId: cognito.clientId,
            AuthParameters: { USERNAME: this.email, SRP_A: A.toString(16) },
        });
        if (challenge.ChallengeName !== 'PASSWORD_VERIFIER' || !challenge.ChallengeParameters) {
            throw unsupportedStep(challenge.ChallengeName);
        }

        const parameters = challenge.ChallengeParameters;
        const userId = parameters.USER_ID_FOR_SRP;
        const poolName = cognito.userPoolId.split('_')[1];
        const key = passwordAuthenticationKey({
            poolName, userId, password: this.password, a, A, B: toBigInt(parameters.SRP_B), salt: toBigInt(parameters.SALT),
        });
        const timestamp = cognitoTimestamp();
        const result = await this.call('RespondToAuthChallenge', {
            ChallengeName: 'PASSWORD_VERIFIER',
            ClientId: cognito.clientId,
            Session: challenge.Session,
            ChallengeResponses: {
                USERNAME: userId,
                PASSWORD_CLAIM_SECRET_BLOCK: parameters.SECRET_BLOCK,
                TIMESTAMP: timestamp,
                PASSWORD_CLAIM_SIGNATURE: passwordClaimSignature({ key, poolName, userId, secretBlock: parameters.SECRET_BLOCK, timestamp }),
            },
        });
        if (!result.AuthenticationResult) {
            throw unsupportedStep(result.ChallengeName);
        }
        const session = toSession(result.AuthenticationResult);
        this.refreshToken = result.AuthenticationResult.RefreshToken;
        this.deviceKey = await this.confirmDevice(result.AuthenticationResult);
        return session;
    }

    /**
     * Komobi's user pool tracks devices: its refresh tokens are bound to a device that has to be confirmed first,
     * as the Komobi app and Amplify do. Without it a refresh fails and every token expiry costs a full login.
     */
    private async confirmDevice(result: AuthenticationResult): Promise<string | undefined> {
        const deviceKey = result.NewDeviceMetadata?.DeviceKey;
        const deviceGroupKey = result.NewDeviceMetadata?.DeviceGroupKey;
        if (!deviceKey || !deviceGroupKey || !result.AccessToken) {
            return undefined;
        }
        const { Salt, PasswordVerifier } = deviceSecretVerifier(deviceGroupKey, deviceKey);
        try {
            await this.call('ConfirmDevice', {
                AccessToken: result.AccessToken,
                DeviceKey: deviceKey,
                DeviceName: userAgent,
                DeviceSecretVerifierConfig: { Salt, PasswordVerifier },
            });
            return deviceKey;
        } catch {
            // Not fatal: the session works, only refreshing it will fall back to logging in again.
            return undefined;
        }
    }

    public async refresh(): Promise<KomobiSession> {
        if (!this.refreshToken) {
            throw new Error('No refresh token; log in again.');
        }
        const result = await this.call('InitiateAuth', {
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            ClientId: cognito.clientId,
            AuthParameters: this.deviceKey
                ? { REFRESH_TOKEN: this.refreshToken, DEVICE_KEY: this.deviceKey }
                : { REFRESH_TOKEN: this.refreshToken },
        });
        if (!result.AuthenticationResult) {
            throw new Error('Cognito did not refresh the session.');
        }
        // Cognito only sends a new refresh token when token rotation is on; otherwise the old one stays valid.
        this.refreshToken = result.AuthenticationResult.RefreshToken ?? this.refreshToken;
        return toSession(result.AuthenticationResult);
    }

    /** Calls one Cognito user pool action; these unauthenticated actions need no AWS signature. */
    private async call(action: string, body: unknown): Promise<CognitoResponse> {
        try {
            const response = await this.http.post<CognitoResponse>('', body, {
                headers: { 'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}` },
            });
            return response.data;
        } catch (err) {
            throw toError(err);
        }
    }
}

const unsupportedStep = (step: string | undefined) => new KomobiLoginError(step === 'NEW_PASSWORD_REQUIRED'
    ? 'Komobi requires a new password for this account; set one in the app first.'
    : `Komobi asked for an extra sign-in step (${step ?? 'none'}), which is not supported.`, undefined, step);

/** Reads the claims of a JWT without verifying it; the token comes straight from Cognito over HTTPS. */
const jwtClaims = (token: string): Record<string, unknown> => {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    } catch {
        return {};
    }
};

const toSession = (result: AuthenticationResult): KomobiSession => {
    if (!result.IdToken || !result.AccessToken) {
        throw new KomobiLoginError('Cognito returned no tokens for this session.');
    }
    const claims = jwtClaims(result.IdToken);
    return {
        idToken: result.IdToken,
        accessToken: result.AccessToken,
        expiresAt: new Date(Number(claims.exp ?? 0) * 1000),
        userSub: String(claims.sub ?? ''),
        claims,
    };
};

/** Turns a Cognito error response ({ __type, message }) into a KomobiLoginError when the credentials are wrong. */
const toError = (err: unknown): Error => {
    if (axios.isAxiosError(err) && err.response) {
        const data = (err.response.data ?? {}) as { __type?: string, message?: string, Message?: string };
        const code = (data.__type ?? '').split('#').pop() || undefined;
        const message = data.message ?? data.Message ?? err.message;
        if (code && CREDENTIAL_ERRORS.includes(code)) {
            return new KomobiLoginError(`Komobi rejected the login: ${message}`, err.response.status, code);
        }
        return new Error(`Cognito ${code ?? err.response.status}: ${message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
};
