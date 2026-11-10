const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { userTransformer, vehicleTransformer, routesTransformer, unwrapItems } = require('../lib/transformers');

// Sanitized copy of real Komobi responses (app 3.3.0); see test/fixtures.
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'responses.json'), 'utf8'));

test('userTransformer reads the fleet id and profile from the list response', () => {
    const user = userTransformer(fixtures.user);
    assert.equal(user.userFleetId, '11111111-1111-1111-1111-111111111111');
    assert.equal(user.firstName, 'Stefan');
    assert.equal(user.lastName, 'Simon');
    assert.equal(user.phone.prefix, '+31');
    assert.equal(user.region, 'GB');
});

test('vehicleTransformer maps vehicle, battery and last location', () => {
    const vehicles = unwrapItems(fixtures.vehicles).map(vehicleTransformer);
    assert.equal(vehicles.length, 1);
    const v = vehicles[0];
    assert.equal(v.brand, 'KAWASAKI');
    assert.equal(v.model, 'Z 650 RS');
    assert.equal(v.currentKm, 821);
    assert.equal(v.registrationNumber, '00-XXX-0');
    assert.equal(v.device.operationMode, 'PARKED');
    assert.equal(v.device.parked, true);
    assert.equal(v.device.internalBatteryPercent, 80);
    assert.equal(v.device.externalBatteryVolts, 13.1);
    assert.ok(Math.abs(v.device.lastLocation.latitude - 51.948567) < 1e-6);
    assert.ok(Math.abs(v.device.lastLocation.longitude - 5.910607) < 1e-6);
});

test('routesTransformer flattens day groups into rides, newest first', () => {
    const routes = routesTransformer(fixtures.routes);
    assert.ok(routes.length >= 2);
    assert.ok(routes[0].startedAt.getTime() >= routes[1].startedAt.getTime());
    const r = routes.find(x => x.routeId === 41);
    assert.equal(r.name, 'Route-41');
    assert.equal(r.distanceKm, 11.651);
    assert.equal(r.maxSpeedKmh, 81);
    assert.equal(r.drivingScore, 8.9);
    assert.equal(r.durationSeconds, 1151);
    assert.equal(r.country, 'Netherlands');
    assert.ok(r.startLocation.latitude > 51 && r.endLocation.latitude > 51);
    assert.ok(r.startedAt instanceof Date && !Number.isNaN(r.startedAt.getTime()));
});
