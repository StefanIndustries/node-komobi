const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Komobi, KomobiLoginError, Endpoints } = require('../lib/komobi');

/**
 * Fake Cognito + API: the authenticator issues numbered ID tokens, the API answers 401
 * to requests whose Authorization header is not the latest token.
 */
function fakeApi(options = {}) {
    const calls = [];
    let issued = 0;
    let validToken;
    const komobi = new Komobi({ email: 'rider@example.com', password: 'pw', baseURL: 'https://fake.test/' });
    const newSession = (ttlMs = 3600 * 1000) => {
        validToken = `id-${++issued}`;
        return { idToken: validToken, accessToken: 'a', expiresAt: new Date(Date.now() + ttlMs), userSub: 'sub', claims: {} };
    };
    komobi['auth'] = {
        login: async () => {
            calls.push('login');
            if (options.rejectLogin) throw new KomobiLoginError('bad credentials', undefined, 'NotAuthorizedException');
            return newSession(options.ttlMs);
        },
        refresh: async () => {
            calls.push('refresh');
            if (!options.refreshWorks) throw new Error('refresh token expired');
            return newSession(options.ttlMs);
        },
    };
    komobi['ax'].defaults.adapter = async config => {
        calls.push(config.url);
        if (calls.length > 50) throw new Error('request loop');
        const ok = !options.alwaysReject && config.headers?.Authorization === validToken;
        const status = ok ? 200 : 401;
        const response = { data: ok ? [{ vehicleId: 'v1' }] : { message: 'Unauthorized' }, status, statusText: '', headers: {}, config };
        if (!ok) {
            const error = new Error('Unauthorized');
            Object.assign(error, { config, response, isAxiosError: true });
            throw error;
        }
        return response;
    };
    return { komobi, calls, revoke: () => { validToken = 'revoked'; } };
}

test('logs in before the first request and sends the ID token', async () => {
    const { komobi, calls } = fakeApi();
    const user = await komobi.getUser();
    assert.deepEqual(calls, ['login', Endpoints.user]);
    assert.deepEqual(user.raw, { vehicleId: 'v1' });
});

test('a rejected token is refreshed and the request retried once', async () => {
    const { komobi, calls, revoke } = fakeApi({ refreshWorks: true });
    await komobi.getUser();
    revoke();
    await komobi.getUser();
    assert.deepEqual(calls, ['login', Endpoints.user, Endpoints.user, 'refresh', Endpoints.user]);
});

test('falls back to a full login when the refresh token no longer works', async () => {
    const { komobi, calls, revoke } = fakeApi();
    await komobi.getUser();
    revoke();
    await komobi.getUser();
    assert.deepEqual(calls, ['login', Endpoints.user, Endpoints.user, 'refresh', 'login', Endpoints.user]);
});

test('an ID token that is about to expire is refreshed before the request', async () => {
    const { komobi, calls } = fakeApi({ refreshWorks: true, ttlMs: 30 * 1000 });
    await komobi.getUser();
    await komobi.getUser();
    assert.deepEqual(calls, ['login', Endpoints.user, 'refresh', Endpoints.user]);
});

test('parallel requests share one login', async () => {
    const { komobi, calls } = fakeApi();
    await Promise.all([komobi.getUser(), komobi.request('GET','x'), komobi.request('GET','y')]);
    assert.equal(calls.filter(c => c === 'login').length, 1);
});

test('a request that keeps being rejected is retried once, not forever', async () => {
    const { komobi, calls } = fakeApi({ alwaysReject: true });
    await assert.rejects(komobi.getUser(), error => error instanceof KomobiLoginError && error.status === 401);
    assert.equal(calls.filter(c => c === Endpoints.user).length, 2);
});

test('wrong credentials throw KomobiLoginError', async () => {
    const { komobi } = fakeApi({ rejectLogin: true });
    await assert.rejects(komobi.login(), error => error instanceof KomobiLoginError && error.code === 'NotAuthorizedException');
});
