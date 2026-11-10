/*
 * Models for the parts of the Komobi API this package exposes. Field names mirror the API where it
 * helps and are simplified where the API nests a { unit, value } pair or wraps data in envelopes.
 * Every model keeps the untouched API object in `raw` so nothing is lost.
 */

export interface KomobiPhone {
    prefix?: string;
    phoneNumber?: string;
    verified?: boolean;
}

export interface KomobiUser {
    /** Internal id that the vehicle and profile endpoints are keyed by. */
    userFleetId: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: KomobiPhone;
    language?: string;
    region?: string;
    raw: unknown;
}

export interface KomobiLocation {
    latitude: number;
    longitude: number;
    /** Time of the GPS fix. */
    timestamp?: Date;
    /** Reported accuracy in meters. */
    accuracyM?: number;
    speedKmh?: number;
}

export interface KomobiDeviceStatus {
    /** Human-readable state the tracker reports, for example "PARKED" or "DRIVING". */
    operationMode?: string;
    parked?: boolean;
    active?: boolean;
    /** Backup battery charge of the tracker, in percent. */
    internalBatteryPercent?: number;
    /** Vehicle battery voltage measured by the tracker, in volts. */
    externalBatteryVolts?: number;
    lastLocation?: KomobiLocation;
    /** Last time the tracker talked to the server. */
    lastCommunication?: Date;
}

export interface KomobiVehicle {
    vehicleId: string;
    deviceId?: string;
    /** License plate. */
    registrationNumber?: string;
    brand?: string;
    model?: string;
    /** Odometer in kilometers. */
    currentKm?: number;
    /** Vehicle battery voltage, in volts. */
    batteryVolts?: number;
    status?: string;
    isElectric?: boolean;
    /** Last time the vehicle sent any activity. */
    lastActivity?: Date;
    /** Tracker status, including the last known position. */
    device?: KomobiDeviceStatus;
    raw: unknown;
}

export interface KomobiRoute {
    /** Numeric id, unique per vehicle. */
    routeId: number;
    name?: string;
    startedAt: Date;
    endedAt?: Date;
    /** Ride length in kilometers. */
    distanceKm?: number;
    /** Riding time in seconds. */
    durationSeconds?: number;
    averageSpeedKmh?: number;
    maxSpeedKmh?: number;
    /** Komobi's 0–10 driving score for the ride. */
    drivingScore?: number;
    country?: string;
    startLocation?: KomobiLocation;
    endLocation?: KomobiLocation;
    raw: unknown;
}
