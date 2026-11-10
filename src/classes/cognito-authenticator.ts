import {
    AuthenticationDetails,
    CognitoRefreshToken,
    CognitoUser,
    CognitoUserPool,
    CognitoUserSession
} from "amazon-cognito-identity-js";
import { cognito } from "../constants";
import { KomobiSession } from "../models/komobi-session";
import { KomobiLoginError } from "./komobi-login-error";

/** Credentials checks Cognito answers with when the e-mail address or password is wrong. */
const CREDENTIAL_ERRORS = ['NotAuthorizedException', 'UserNotFoundException', 'UserNotConfirmedException', 'PasswordResetRequiredException'];

export interface Authenticator {
    login(): Promise<KomobiSession>;
    refresh(refreshToken: string): Promise<KomobiSession>;
}

/** Logs in to the Komobi Cognito user pool the same way the app does (SRP, so the password never leaves this machine). */
export class CognitoAuthenticator implements Authenticator {
    private readonly pool = new CognitoUserPool({ UserPoolId: cognito.userPoolId, ClientId: cognito.clientId });

    constructor(private email: string, private password: string) {
    }

    public login(): Promise<KomobiSession> {
        const user = this.createUser();
        const details = new AuthenticationDetails({ Username: this.email, Password: this.password });
        return new Promise((resolve, reject) => {
            user.authenticateUser(details, {
                onSuccess: (session) => resolve(toSession(session)),
                onFailure: (err) => reject(toError(err)),
                newPasswordRequired: () => reject(new KomobiLoginError('Komobi requires a new password for this account; set one in the app first.')),
                mfaRequired: () => reject(new KomobiLoginError('Multi-factor authentication is not supported.')),
                totpRequired: () => reject(new KomobiLoginError('Multi-factor authentication is not supported.')),
            });
        });
    }

    public refresh(refreshToken: string): Promise<KomobiSession> {
        const user = this.createUser();
        return new Promise((resolve, reject) => {
            user.refreshSession(new CognitoRefreshToken({ RefreshToken: refreshToken }), (err, session) => {
                if (err) {
                    reject(toError(err));
                } else {
                    resolve(toSession(session));
                }
            });
        });
    }

    private createUser(): CognitoUser {
        return new CognitoUser({ Username: this.email, Pool: this.pool });
    }
}

const toSession = (session: CognitoUserSession): KomobiSession => {
    const idToken = session.getIdToken();
    return {
        idToken: idToken.getJwtToken(),
        accessToken: session.getAccessToken().getJwtToken(),
        refreshToken: session.getRefreshToken().getToken(),
        expiresAt: new Date(idToken.getExpiration() * 1000),
        userSub: String(idToken.payload['sub'] ?? ''),
        claims: idToken.payload,
    };
};

const toError = (err: unknown): Error => {
    const code = (err as { code?: string, name?: string })?.code ?? (err as { name?: string })?.name;
    if (code && CREDENTIAL_ERRORS.includes(code)) {
        return new KomobiLoginError(`Komobi rejected the login: ${(err as Error).message ?? code}`, undefined, code);
    }
    return err instanceof Error ? err : new Error(String(err));
};
