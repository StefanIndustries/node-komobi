import {
    KomobiDeviceStatus,
    KomobiKeychain,
    KomobiLocation,
    KomobiRoute,
    KomobiUser,
    KomobiVehicle
} from "./models/komobi-models";

/* Maps the raw Komobi JSON (shapes confirmed from the app 3.3.0) onto the package models. */

type Raw = Record<string, unknown>;

const obj = (value: unknown): Raw => (value && typeof value === 'object' ? value as Raw : {});
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : value != null && typeof value !== 'object' ? String(value) : undefined);
/** Komobi timestamps are unix seconds. */
const date = (value: unknown): Date | undefined => {
    const n = num(value);
    return n && n > 0 ? new Date(n * 1000) : undefined;
};
/** Many values are wrapped as { unit, value }. */
const measure = (value: unknown): number | undefined => num(obj(value).value);

/** Unwraps the `{ items: [...] }` / `{ items, count }` envelopes the API uses for lists. */
export const unwrapItems = (value: unknown): unknown[] => {
    if (Array.isArray(value)) {
        return value;
    }
    const items = obj(value).items;
    return Array.isArray(items) ? items : [];
};

const locationTransformer = (value: unknown): KomobiLocation | undefined => {
    const gps = obj(obj(value).gps);
    const location = obj(gps.location);
    const latitude = num(location.latitude);
    const longitude = num(location.longitude);
    if (latitude === undefined || longitude === undefined) {
        return undefined;
    }
    return {
        latitude,
        longitude,
        timestamp: date(obj(value).timestamp),
        accuracyM: measure(gps.accuracy),
        speedKmh: measure(gps.speed),
    };
};

export const userTransformer = (value: unknown): KomobiUser => {
    const record = obj(Array.isArray(value) ? value[0] : value);
    const profile = obj(record.userProfile);
    const phone = obj(profile.phone);
    return {
        userFleetId: String(record.userFleetId ?? ''),
        email: str(record.userEmail),
        firstName: str(profile.firstName),
        lastName: str(profile.lastName),
        phone: profile.phone ? {
            prefix: str(phone.prefix),
            phoneNumber: str(phone.phoneNumber),
            verified: phone.verified === true,
        } : undefined,
        language: str(profile.language),
        region: str(profile.region),
        raw: record,
    };
};

const deviceStatusTransformer = (device: Raw): KomobiDeviceStatus | undefined => {
    const status = obj(device.status);
    if (Object.keys(status).length === 0) {
        return undefined;
    }
    const battery = obj(status.battery);
    const lastCommunication = date(obj(status.lastComunication).timestamp);
    const lastLocation = locationTransformer(status.lastLocation);
    // The vehicle's last-location object carries no timestamp of its own; use the last communication time.
    if (lastLocation && !lastLocation.timestamp) {
        lastLocation.timestamp = lastCommunication;
    }
    return {
        operationMode: str(status.operationMode),
        parked: status.parked === true,
        active: status.isActive === true,
        internalBatteryPercent: measure(battery.internal),
        externalBatteryVolts: measure(battery.external),
        lastLocation,
        lastCommunication,
        keychains: (Array.isArray(device.keychains) ? device.keychains : []).map(keychainTransformer).filter(k => k.bleId),
    };
};

/** Komobi sends the key fob battery as a string ("100"); the tracker's own battery is a number. */
const numeric = (value: unknown): number | undefined => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return num(n);
};

export const keychainTransformer = (value: unknown): KomobiKeychain => {
    const k = obj(value);
    const status = obj(k.status);
    const config = obj(k.config);
    const bool = (b: unknown) => (typeof b === 'boolean' ? b : undefined);
    return {
        bleId: str(k.bleId) ?? '',
        name: str(k.name),
        batteryPercent: numeric(obj(status.battery).value),
        lastCommunication: date(obj(status.lastComunication).timestamp),
        enabled: bool(status.enabled),
        forgottenNotificationActive: bool(config.forgotNotificationActive),
        forgottenWarning: bool(status.forgotNotificationWarning),
        raw: k,
    };
};

export const vehicleTransformer = (value: unknown): KomobiVehicle => {
    const v = obj(value);
    const device = obj(v.device);
    return {
        vehicleId: String(v.vehicleId ?? ''),
        deviceId: str(v.deviceId),
        registrationNumber: str(v.registrationNumber),
        brand: str(v.brand),
        model: str(v.model),
        currentKm: num(v.currentKm),
        batteryVolts: num(v.battery),
        status: str(v.status),
        isElectric: v.isElectric === true,
        lastActivity: date(v.lastActivity),
        device: deviceStatusTransformer(device),
        raw: v,
    };
};

export const routeTransformer = (value: unknown): KomobiRoute => {
    const r = obj(value);
    const stats = obj(r.routeStats);
    const gps = obj(stats.gps);
    const speed = obj(gps.speed);
    const summary = obj(r.locationsSummary);
    return {
        routeId: num(r.routeId) ?? -1,
        name: str(r.routeName),
        startedAt: date(r.dateInit) ?? new Date(NaN),
        endedAt: date(r.dateEnd),
        distanceKm: measure(gps.distance),
        durationSeconds: measure(stats.useTime),
        averageSpeedKmh: measure(speed.average),
        maxSpeedKmh: measure(speed.max),
        drivingScore: num(stats.drivingScore),
        country: str(gps.country),
        startLocation: locationTransformer(summary.locationInit),
        endLocation: locationTransformer(summary.locationEnd),
        raw: r,
    };
};

/**
 * The routes endpoint groups rides by day: `{ items: [ { "2026-11-09": [ { routes: [...] } ] } ] }`.
 * This flattens every ride across all days into a single list, newest first.
 */
export const routesTransformer = (value: unknown): KomobiRoute[] => {
    const routes: KomobiRoute[] = [];
    for (const dayGroup of unwrapItems(value)) {
        for (const entries of Object.values(obj(dayGroup))) {
            for (const entry of Array.isArray(entries) ? entries : []) {
                for (const route of Array.isArray(obj(entry).routes) ? obj(entry).routes as unknown[] : []) {
                    routes.push(routeTransformer(route));
                }
            }
        }
    }
    return routes.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
};
