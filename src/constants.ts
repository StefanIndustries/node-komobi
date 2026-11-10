/*
 * Values taken from the Komobi Android app 3.3.0 (com.livelinkventures.livelinkmotor):
 * res/raw/amplifyconfiguration.json, and the Retrofit interface decompiled from classes*.dex
 * (HTTP verb, path, and every @Path/@Query/@Body parameter).
 */

/** API Gateway the app talks to. The stage is called "dev", but it is the only one the app ships with. */
export const defaultBaseURL = 'https://cv5wftmvd8.execute-api.eu-west-1.amazonaws.com/dev/';

/** Cognito user pool used by the app (USER_SRP_AUTH, e-mail as username, no MFA). */
export const cognito = {
    userPoolId: 'eu-west-1_dr8gful6U',
    clientId: '48kk70l6todsj5aodtdpm4duqs',
    region: 'eu-west-1',
} as const;

/** The app's internal name for its tenant, used by the public (API-key) endpoints. */
export const pool = 'KOMOBI';

/**
 * API Gateway key the app sends as `x-api-key` on the endpoints annotated ApiKeyAuthorization
 * (user lookup by Cognito id, policies, support info). Read from the app; not a user secret.
 */
export const apiKey = 'iocmD1rasJ7Tzwq3TWcwK4SQLKHcu0Jj54iCf95M';

export const userAgent = 'node-komobi';

const id = (value: string) => encodeURIComponent(value);

/**
 * API paths relative to the base URL (read-only subset). Each path is followed by the query
 * parameters the app sends; see the method on Komobi for how they are filled in.
 */
export const Endpoints = {
    /** GET ?id=<cognito sub>&pool=KOMOBI (x-api-key) -> the user record, including the internal fleet id. */
    user: 'v1/users',
    userById: (userId: string) => `v1/users/${id(userId)}`,
    /** GET {userId}/stats ?startDate&endDate&timeZone&indicator&aggregation&vehicleId */
    userStats: (userId: string) => `v1/users/${id(userId)}/stats`,

    /** GET ?userFleetId&expandedInfo&locale -> the vehicles of a fleet. */
    vehicles: 'v1/vehicles',
    /** GET {vehicleId} ?expandedInfo&locale */
    vehicle: (vehicleId: string) => `v1/vehicles/${id(vehicleId)}`,
    maintenance: (vehicleId: string) => `v2/vehicles/${id(vehicleId)}/maintenance`,

    /** GET ?vehicleId&aggregation&aggregationLimitTo&startDate&endDate&timeZone -> rides. */
    routes: 'v2/vehicles/routes',
    route: (vehicleId: string, routeId: string) => `v2/vehicles/${id(vehicleId)}/routes/${id(routeId)}`,
    routeDetail: (vehicleId: string, routeId: string) => `v2/vehicles/${id(vehicleId)}/routes/${id(routeId)}/detail`,
    routeGps: (vehicleId: string, routeId: string) => `v2/vehicles/${id(vehicleId)}/routes/${id(routeId)}/detail/gps`,

    /** GET ?vehicleId&aggregation&aggregationLimitTo&startDate&endDate&timeZone -> theft alarms. */
    alarms: 'v2/vehicles/alarms',
    alarmDetail: (vehicleId: string, alarmId: string) => `v2/vehicles/${id(vehicleId)}/alarms/${id(alarmId)}/detail`,

    /** GET {deviceId} -> tracker status (battery, connectivity, last position). */
    device: (deviceId: string) => `v2/devices/${id(deviceId)}`,
    deviceServices: (deviceId: string) => `v1/devices/${id(deviceId)}/services`,
    deviceAlarmConfig: (deviceId: string) => `v1/devices/${id(deviceId)}/alarms/config`,
} as const;

/** Aggregation buckets the routes/alarms/stats endpoints accept. NONE returns the raw items. */
export type Aggregation = 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
