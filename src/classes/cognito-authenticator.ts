import { Amplify } from "aws-amplify";
import { fetchAuthSession, getCurrentUser, signIn, signOut } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sharedInMemoryStorage } from "aws-amplify/utils";
import { cognito } from "../constants";
import { KomobiSession } from "../models/komobi-session";
import { KomobiLoginError } from "./komobi-login-error";

/** Cognito errors meaning the e-mail address or password is not accepted. */
const CREDENTIAL_ERRORS = ['NotAuthorizedException', 'UserNotFoundException', 'UserNotConfirmedException', 'PasswordResetRequiredException'];

export interface Authenticator {
    login(): Promise<KomobiSession>;
    /** Refreshes the current session; rejects when it can not, so the caller can log in again. */
    refresh(): Promise<KomobiSession>;
}

/*
 * Amplify v6 is a process-wide singleton: one configuration and one signed-in user, with the refresh
 * token kept in its own (here: in-memory) token store. Sign-ins from different Komobi instances are
 * therefore run one at a time, and the e-mail of the signed-in user is tracked so an instance never
 * refreshes someone else's session.
 */
let configured = false;
let signedInEmail: string | undefined = undefined;
let queue: Promise<unknown> = Promise.resolve();

const configure = () => {
    if (configured) {
        return;
    }
    Amplify.configure({
        Auth: {
            Cognito: {
                userPoolId: cognito.userPoolId,
                userPoolClientId: cognito.clientId,
                loginWith: { email: true },
            },
        },
    });
    // Node has no localStorage; keep tokens in memory instead of Amplify's browser default.
    cognitoUserPoolsTokenProvider.setKeyValueStorage(sharedInMemoryStorage);
    configured = true;
};

/** Runs the given step after every earlier Amplify step has finished. */
const serialized = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step, step);
    queue = run.catch(() => undefined);
    return run;
};

/** Logs in to the Komobi Cognito user pool the same way the app does (SRP, so the password never leaves this machine). */
export class CognitoAuthenticator implements Authenticator {
    constructor(private email: string, private password: string) {
        configure();
    }

    public login(): Promise<KomobiSession> {
        return serialized(async () => {
            // Amplify refuses a second sign-in while a user is signed in.
            if (await isSignedIn()) {
                await signOut();
            }
            signedInEmail = undefined;
            let result;
            try {
                result = await signIn({
                    username: this.email,
                    password: this.password,
                    options: { authFlowType: 'USER_SRP_AUTH' },
                });
            } catch (err) {
                throw toError(err);
            }
            const step = result.nextStep.signInStep;
            if (!result.isSignedIn || step !== 'DONE') {
                throw new KomobiLoginError(step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'
                    ? 'Komobi requires a new password for this account; set one in the app first.'
                    : `Komobi asked for an extra sign-in step (${step}), which is not supported.`, undefined, step);
            }
            signedInEmail = this.email;
            return currentSession(false);
        });
    }

    public refresh(): Promise<KomobiSession> {
        return serialized(async () => {
            if (signedInEmail !== this.email) {
                throw new Error('Another account is signed in to Amplify; log in again.');
            }
            return currentSession(true);
        });
    }
}

const isSignedIn = async (): Promise<boolean> => {
    try {
        await getCurrentUser();
        return true;
    } catch {
        return false;
    }
};

const currentSession = async (forceRefresh: boolean): Promise<KomobiSession> => {
    const { tokens } = await fetchAuthSession({ forceRefresh });
    if (!tokens?.idToken || !tokens.accessToken) {
        throw new KomobiLoginError('Cognito returned no tokens for this session.');
    }
    const claims = tokens.idToken.payload as Record<string, unknown>;
    const exp = Number(claims.exp ?? 0);
    return {
        idToken: tokens.idToken.toString(),
        accessToken: tokens.accessToken.toString(),
        expiresAt: new Date(exp * 1000),
        userSub: String(claims.sub ?? ''),
        claims,
    };
};

const toError = (err: unknown): Error => {
    const name = (err as { name?: string })?.name;
    if (name && CREDENTIAL_ERRORS.includes(name)) {
        return new KomobiLoginError(`Komobi rejected the login: ${(err as Error).message ?? name}`, undefined, name);
    }
    return err instanceof Error ? err : new Error(String(err));
};
