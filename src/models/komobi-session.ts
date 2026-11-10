export interface KomobiSession {
    /** Cognito ID token; this is what the API expects in the Authorization header. */
    idToken: string;
    accessToken: string;
    expiresAt: Date;
    /** Cognito user id (the `sub` claim). */
    userSub: string;
    /** All claims of the ID token, for example email and custom attributes. */
    claims: Record<string, unknown>;
}
