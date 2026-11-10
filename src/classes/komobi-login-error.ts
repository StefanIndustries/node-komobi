/**
 * Thrown when Komobi rejects the credentials, or when a request is still rejected
 * after logging in again.
 */
export class KomobiLoginError extends Error {
    /** HTTP status of the rejected API request, if any. */
    public readonly status?: number;
    /** Cognito error code, for example NotAuthorizedException. */
    public readonly code?: string;

    constructor(message: string, status?: number, code?: string) {
        super(message);
        this.name = 'KomobiLoginError';
        this.status = status;
        this.code = code;
    }
}
