import { Komobi } from "./src/komobi";

async function main() {
    const komobi = new Komobi({
        email: process.env.KOMOBI_EMAIL!,
        password: process.env.KOMOBI_PASSWORD!,
        timeZone: "Europe/Amsterdam",
    });

    const user = await komobi.getUser();
    console.log(`${user.firstName} ${user.lastName} (fleet ${user.userFleetId})`);

    const vehicles = await komobi.getVehicles();
    for (const v of vehicles) {
        console.log(`${v.brand} ${v.model} - ${v.currentKm} km`);
        console.log("last location:", v.device?.lastLocation);

        const routes = await komobi.getRoutes(v.vehicleId, {
            from: new Date(Date.now() - 30 * 24 * 3600 * 1000),
        });
        console.log(`${routes.length} rides in the last 30 days`);
        for (const r of routes.slice(0, 5)) {
            console.log(`  ${r.startedAt.toISOString()}  ${r.distanceKm} km, max ${r.maxSpeedKmh} km/h, score ${r.drivingScore}`);
        }
    }

    komobi.dispose();
}

main().then(() => {
    console.log("program done");
});
