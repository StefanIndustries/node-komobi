const assert = require('node:assert/strict');
const { test } = require('node:test');
const srp = require('../lib/classes/cognito-srp');
const { CognitoAuthenticator } = require('../lib/classes/cognito-authenticator');
const { KomobiLoginError } = require('../lib/komobi');

// Expected values were produced by AWS Amplify's own SRP helpers (aws-amplify 6) for the same inputs.
test('SRP key and signature match the AWS Amplify implementation', () => {
    const { a, A } = srp.createClientKeys(Buffer.alloc(128, 7));
    const B = srp.modPow(srp.g, srp.toBigInt('1234567890abcdef'.repeat(8)), srp.N);
    const key = srp.passwordAuthenticationKey({
        poolName: 'dr8gful6U', userId: 'user-id-for-srp', password: 'secret', a, A, B, salt: srp.toBigInt('a1b2c3d4e5f60718293a4b5c6d7e8f90'),
    });
    assert.equal(key.toString('hex'), '5385c556f94946e795947bc79689bd80');
    const signature = srp.passwordClaimSignature({
        key, poolName: 'dr8gful6U', userId: 'user-id-for-srp',
        secretBlock: Buffer.from('secret block').toString('base64'), timestamp: 'Tue Nov 3 09:05:07 UTC 2026',
    });
    assert.equal(signature, 'mzIAFx7PstQJfDnXjxhNPjUxZuhYHkuW8WpGFMTx6yg=');
});

test('SRP helpers: padding, group and timestamp', () => {
    assert.equal(srp.padHex(BigInt(0x14)), '14');
    assert.equal(srp.padHex(BigInt(0xec)), '00ec');
    assert.equal(srp.padHex(BigInt(0x123)), '0123');
    assert.equal(srp.N.toString(16).length, 768);
    assert.equal(srp.cognitoTimestamp(new Date(Date.UTC(2026, 10, 3, 9, 5, 7))), 'Tue Nov 3 09:05:07 UTC 2026');
    assert.equal(srp.modPow(BigInt(3), BigInt(200), BigInt(1000)), BigInt(1));
});

const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** An authenticator whose Cognito calls are answered by `handler(target, body)`. */
function fakeCognito(handler) {
    const calls = [];
    const auth = new CognitoAuthenticator('rider@example.com', 'pw');
    auth['http'].defaults.adapter = async config => {
        const target = config.headers['X-Amz-Target'].split('.').pop();
        const body = JSON.parse(config.data);
        calls.push([target, body]);
        const [status, data] = handler(target, body);
        const response = { data, status, statusText: '', headers: {}, config };
        if (status >= 400) {
            throw Object.assign(new Error(`Request failed with status code ${status}`), { config, response, isAxiosError: true });
        }
        return response;
    };
    return { auth, calls };
}

const challenge = { ChallengeName: 'PASSWORD_VERIFIER', Session: 'sess', ChallengeParameters: {
    USER_ID_FOR_SRP: 'uuid-1', SALT: 'a1b2', SECRET_BLOCK: Buffer.from('block').toString('base64'),
    SRP_B: srp.modPow(srp.g, BigInt(12345), srp.N).toString(16), USERNAME: 'uuid-1',
} };

test('logs in with USER_SRP_AUTH and PASSWORD_VERIFIER, then refreshes with the refresh token', async () => {
    const tokens = { IdToken: jwt({ sub: 'uuid-1', exp: 2000000000, email: 'rider@example.com' }), AccessToken: 'access', RefreshToken: 'refresh-1' };
    const { auth, calls } = fakeCognito((target, body) => {
        if (target === 'InitiateAuth' && body.AuthFlow === 'USER_SRP_AUTH') return [200, challenge];
        if (target === 'RespondToAuthChallenge') return [200, { AuthenticationResult: tokens }];
        if (target === 'InitiateAuth' && body.AuthFlow === 'REFRESH_TOKEN_AUTH') return [200, { AuthenticationResult: { ...tokens, RefreshToken: undefined } }];
        return [400, { __type: 'InvalidParameterException' }];
    });

    const session = await auth.login();
    assert.equal(session.userSub, 'uuid-1');
    assert.equal(session.expiresAt.getTime(), 2000000000 * 1000);
    assert.equal(session.claims.email, 'rider@example.com');

    const [initiate, respond] = calls;
    assert.equal(initiate[1].AuthParameters.USERNAME, 'rider@example.com');
    assert.match(initiate[1].AuthParameters.SRP_A, /^[0-9a-f]+$/);
    assert.equal(respond[1].ChallengeName, 'PASSWORD_VERIFIER');
    assert.equal(respond[1].Session, 'sess');
    assert.equal(respond[1].ChallengeResponses.USERNAME, 'uuid-1');
    assert.equal(respond[1].ChallengeResponses.PASSWORD_CLAIM_SECRET_BLOCK, challenge.ChallengeParameters.SECRET_BLOCK);
    assert.match(respond[1].ChallengeResponses.TIMESTAMP, /^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d UTC \d{4}$/);
    assert.match(respond[1].ChallengeResponses.PASSWORD_CLAIM_SIGNATURE, /^[A-Za-z0-9+/]{43}=$/);

    await auth.refresh();
    await auth.refresh();
    // Cognito sent no new refresh token, so the first one keeps being used.
    assert.deepEqual(calls.slice(2).map(([, body]) => body.AuthParameters.REFRESH_TOKEN), ['refresh-1', 'refresh-1']);
});

test('a tracked device is confirmed after login and its key is sent with every refresh', async () => {
    const result = {
        IdToken: jwt({ sub: 'uuid-1' }), AccessToken: 'access-1', RefreshToken: 'refresh-1',
        NewDeviceMetadata: { DeviceKey: 'eu-west-1_device', DeviceGroupKey: '-group' },
    };
    const { auth, calls } = fakeCognito((target, body) => {
        if (target === 'InitiateAuth' && body.AuthFlow === 'USER_SRP_AUTH') return [200, challenge];
        if (target === 'RespondToAuthChallenge') return [200, { AuthenticationResult: result }];
        if (target === 'ConfirmDevice') return [200, { UserConfirmationNecessary: false }];
        // Like Cognito: a device-bound refresh token is rejected without its device key.
        if (body.AuthParameters?.DEVICE_KEY !== 'eu-west-1_device') return [400, { __type: 'NotAuthorizedException', message: 'Invalid Refresh Token.' }];
        return [200, { AuthenticationResult: { IdToken: jwt({ sub: 'uuid-1' }), AccessToken: 'access-2' } }];
    });
    await auth.login();
    const confirm = calls.find(([target]) => target === 'ConfirmDevice')[1];
    assert.equal(confirm.AccessToken, 'access-1');
    assert.equal(confirm.DeviceKey, 'eu-west-1_device');
    assert.ok(Buffer.from(confirm.DeviceSecretVerifierConfig.Salt, 'base64').length >= 16);
    assert.ok(Buffer.from(confirm.DeviceSecretVerifierConfig.PasswordVerifier, 'base64').length >= 384);
    assert.equal((await auth.refresh()).accessToken, 'access-2');

    // Same values as AWS Amplify's generateHashDevice for these inputs.
    const fixed = srp.deviceSecretVerifier('-group', 'eu-west-1_device', 'device-password', Buffer.alloc(16, 0xab));
    assert.equal(fixed.Salt, 'AKurq6urq6urq6urq6urq6s=');
});

test('a failed device confirmation does not fail the login', async () => {
    const { auth } = fakeCognito((target, body) => {
        if (target === 'InitiateAuth') return [200, challenge];
        if (target === 'ConfirmDevice') return [400, { __type: 'InternalErrorException' }];
        return [200, { AuthenticationResult: { IdToken: jwt({ sub: 'x' }), AccessToken: 'a', RefreshToken: 'r', NewDeviceMetadata: { DeviceKey: 'k', DeviceGroupKey: 'g' } } }];
    });
    assert.equal((await auth.login()).userSub, 'x');
});

test('wrong credentials become a KomobiLoginError with the Cognito code', async () => {
    const { auth } = fakeCognito(target => target === 'InitiateAuth'
        ? [400, { __type: 'com.amazonaws#NotAuthorizedException', message: 'Incorrect username or password.' }]
        : [500, {}]);
    await assert.rejects(auth.login(), err => err instanceof KomobiLoginError && err.code === 'NotAuthorizedException' && /Incorrect/.test(err.message));
});

test('other Cognito errors and extra sign-in steps are reported', async () => {
    const throttled = fakeCognito(() => [400, { __type: 'TooManyRequestsException', message: 'Rate exceeded' }]);
    await assert.rejects(throttled.auth.login(), err => !(err instanceof KomobiLoginError) && /TooManyRequestsException: Rate exceeded/.test(err.message));

    const mfa = fakeCognito(target => target === 'InitiateAuth' ? [200, challenge] : [200, { ChallengeName: 'SMS_MFA', Session: 's2' }]);
    await assert.rejects(mfa.auth.login(), err => err instanceof KomobiLoginError && err.code === 'SMS_MFA');

    const fresh = fakeCognito(() => [200, {}]);
    await assert.rejects(fresh.auth.refresh(), /log in again/);
});

test('each authenticator keeps its own session, so two accounts do not sign each other out', async () => {
    const one = fakeCognito((target, body) => body.AuthFlow === 'REFRESH_TOKEN_AUTH'
        ? [200, { AuthenticationResult: { IdToken: jwt({ sub: 'one' }), AccessToken: 'a' } }]
        : target === 'InitiateAuth' ? [200, challenge] : [200, { AuthenticationResult: { IdToken: jwt({ sub: 'one' }), AccessToken: 'a', RefreshToken: 'r-one' } }]);
    const two = fakeCognito((target) => target === 'InitiateAuth'
        ? [200, challenge] : [200, { AuthenticationResult: { IdToken: jwt({ sub: 'two' }), AccessToken: 'a', RefreshToken: 'r-two' } }]);
    await one.auth.login();
    await two.auth.login();
    assert.equal((await one.auth.refresh()).userSub, 'one');
    assert.equal(one.calls.at(-1)[1].AuthParameters.REFRESH_TOKEN, 'r-one');
});
