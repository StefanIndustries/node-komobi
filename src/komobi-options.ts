export interface KomobiOptions {
    /** E-mail address of the Komobi account. */
    email: string,
    password: string,
    /** Overrides the API base URL, for example to point at a test server. */
    baseURL?: string,
    /** Request timeout in milliseconds. Defaults to 15000. */
    timeout?: number,
    /** Default IANA time zone for the ride/alarm/stats history endpoints. Defaults to UTC. */
    timeZone?: string,
}
