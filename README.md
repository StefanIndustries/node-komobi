# node-komobi

Unofficial API client for [Komobi](https://www.komobimoto.com), the GPS tracker for motorcycles and scooters.
Reads your vehicles, tracker status and location, ride history, statistics and maintenance.

Login, endpoints and response shapes were taken from the Komobi Android app (3.3.0,
`com.livelinkventures.livelinkmotor`) and verified against a live account. The user, vehicle and
ride methods return typed models; the less common endpoints return the raw API JSON.

All async methods return promises and can be awaited.

## Installation

```bash
npm install node-komobi
```

## Usage

```typescript
import { Komobi } from "node-komobi";

const komobi = new Komobi({
    email: process.env.KOMOBI_EMAIL!,
    password: process.env.KOMOBI_PASSWORD!,
    timeZone: "Europe/Amsterdam",
});

const user = await komobi.getUser();
console.log(user.firstName, user.lastName);

const vehicles = await komobi.getVehicles();
const bike = vehicles[0];
console.log(`${bike.brand} ${bike.model} - ${bike.currentKm} km`);
console.log(bike.device?.lastLocation);   // { latitude, longitude, timestamp, ... }

const routes = await komobi.getRoutes(bike.vehicleId, {
    from: new Date(Date.now() - 30 * 24 * 3600 * 1000),
});
for (const r of routes) {
    console.log(r.startedAt, r.distanceKm, "km, max", r.maxSpeedKmh, "km/h, score", r.drivingScore);
}

komobi.dispose();
```

Login uses the same AWS Cognito user pool as the app (SRP, so the password itself is never sent).
It happens automatically before the first request; the ID token is refreshed before it expires and
when the API rejects it, after which the request is retried once. Wrong credentials throw a `KomobiLoginError`.

`getVehicles()` first resolves the account's internal fleet id from the user record (and caches it),
because the vehicle endpoint is keyed by fleet, not by the login. Komobi expects the account's
**e-mail address** as the user lookup key, which the client handles for you.

## Methods

Typed (see [src/models/komobi-models.ts](src/models/komobi-models.ts)):

| Method | Returns |
| --- | --- |
| `login()` | `KomobiSession` |
| `getUser()` | `KomobiUser` (name, phone, `userFleetId`) |
| `getUserFleetId()` | `string` — cached internal fleet id |
| `getVehicles()` / `getVehicle(vehicleId)` | `KomobiVehicle[]` / `KomobiVehicle` (mileage, battery, tracker status + last GPS) |
| `getRoutes(vehicleId, { from, to })` | `KomobiRoute[]` — rides with distance, speed, driving score, start/end GPS |

Raw (return the API JSON as `unknown`):

| Method | API path |
| --- | --- |
| `getRoutesRaw(vehicleId, …)` | `v2/vehicles/routes` (grouped by day) |
| `getRouteDetail(vehicleId, routeId)` | `v2/vehicles/{vehicleId}/routes/{routeId}/detail` |
| `getRouteGps(vehicleId, routeId)` | `.../detail/gps` |
| `getAlarms(vehicleId, { from, to })` | `v2/vehicles/alarms` |
| `getMaintenance(vehicleId)` | `v2/vehicles/{vehicleId}/maintenance` |
| `getStats({ from, to, aggregation, vehicleId })` | `v1/users/{userId}/stats` |
| `getDevice(deviceId)` | `v2/devices/{deviceId}` |
| `accountExists()` | whether Komobi provisioned the account |
| `request(method, path, params?, data?)` | any other path, authenticated |
| `dispose()` | aborts running requests |

Every typed model also exposes the untouched API object as `.raw`.

## Development

Create a `.env` with `KOMOBI_EMAIL` and `KOMOBI_PASSWORD`, then:

```bash
npm install
npm test        # builds and runs the mocked auth + transformer tests
npm run lint
npm start       # runs app.ts
```
