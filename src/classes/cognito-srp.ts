import { createHash, createHmac, getDiffieHellman, randomBytes } from "node:crypto";

/*
 * The Secure Remote Password math Cognito's USER_SRP_AUTH flow expects, with node:crypto and BigInt instead of
 * an SDK. It follows the AWS Amplify implementation byte for byte: same group, padding, hashing and HKDF.
 */

/** The 3072-bit MODP group (RFC 3526 group 15), which is the group Cognito uses. */
export const N = BigInt(`0x${getDiffieHellman('modp15').getPrime('hex')}`);
const ZERO = BigInt(0);
const ONE = BigInt(1);
export const g = BigInt(2);

const toBigInt = (hex: string): bigint => BigInt(`0x${hex || '0'}`);

/**
 * Even-length hex of a positive integer, with a leading 00 when the top bit is set: the two's-complement
 * encoding Java's BigInteger uses, which Cognito hashes.
 */
export function padHex(value: bigint): string {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) {
        hex = `0${hex}`;
    }
    return /^[89a-f]/i.test(hex) ? `00${hex}` : hex;
}

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
/** SHA-256 of the bytes a hex string encodes, as 64 hex characters. */
const hashHex = (hex: string): string => sha256Hex(Buffer.from(hex, 'hex')).padStart(64, '0');

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = ONE;
    let b = ((base % modulus) + modulus) % modulus;
    let e = exponent;
    while (e > ZERO) {
        if (e & ONE) {
            result = (result * b) % modulus;
        }
        e >>= ONE;
        b = (b * b) % modulus;
    }
    return result;
}

/** k = H(N | g), the SRP-6a multiplier. */
export const k = toBigInt(hashHex(`${padHex(N)}${padHex(g)}`));

/** A fresh client secret `a` (128 random bytes) and its public value A = g^a mod N. */
export function createClientKeys(random: Buffer = randomBytes(128)): { a: bigint, A: bigint } {
    const a = toBigInt(random.toString('hex'));
    const A = modPow(g, a, N);
    if (A % N === ZERO) {
        throw new Error('A cannot be zero.');
    }
    return { a, A };
}

/**
 * The 16-byte key both sides derive: HKDF over the shared secret S, salted with u = H(A | B).
 * `userId` is USER_ID_FOR_SRP from the challenge; `poolName` is the part of the user pool id after the underscore.
 */
export function passwordAuthenticationKey(params: {
    poolName: string, userId: string, password: string, a: bigint, A: bigint, B: bigint, salt: bigint,
}): Buffer {
    const { poolName, userId, password, a, A, B, salt } = params;
    if (B % N === ZERO) {
        throw new Error('B cannot be zero.');
    }
    const u = toBigInt(hashHex(padHex(A) + padHex(B)));
    if (u === ZERO) {
        throw new Error('U cannot be zero.');
    }
    const usernamePasswordHash = sha256Hex(`${poolName}${userId}:${password}`).padStart(64, '0');
    const x = toBigInt(hashHex(padHex(salt) + usernamePasswordHash));
    const S = modPow(B - k * modPow(g, x, N), a + u * x, N);

    const prk = createHmac('sha256', Buffer.from(padHex(u), 'hex')).update(Buffer.from(padHex(S), 'hex')).digest();
    const info = Buffer.concat([Buffer.from('Caldera Derived Key', 'utf8'), Buffer.from([1])]);
    return createHmac('sha256', prk).update(info).digest().subarray(0, 16);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The timestamp Cognito signs, "Tue Nov 10 15:22:27 UTC 2026" (day without leading zero). */
export function cognitoTimestamp(date: Date = new Date()): string {
    const two = (n: number) => String(n).padStart(2, '0');
    return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} `
        + `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC ${date.getUTCFullYear()}`;
}

/** PASSWORD_CLAIM_SIGNATURE: HMAC of pool name, user id, secret block and timestamp with the derived key. */
export function passwordClaimSignature(params: {
    key: Buffer, poolName: string, userId: string, secretBlock: string, timestamp: string,
}): string {
    const { key, poolName, userId, secretBlock, timestamp } = params;
    return createHmac('sha256', key)
        .update(Buffer.concat([
            Buffer.from(poolName, 'utf8'),
            Buffer.from(userId, 'utf8'),
            Buffer.from(secretBlock, 'base64'),
            Buffer.from(timestamp, 'utf8'),
        ]))
        .digest('base64');
}

/**
 * The secret verifier ConfirmDevice needs when the user pool tracks devices: a random device password, hashed with
 * the device group and key like a user password, as base64 salt and verifier.
 */
export function deviceSecretVerifier(deviceGroupKey: string, deviceKey: string,
    password: string = randomBytes(40).toString('base64'), saltBytes: Buffer = randomBytes(16)) {
    const hashed = sha256Hex(`${deviceGroupKey}${deviceKey}:${password}`).padStart(64, '0');
    const salt = padHex(toBigInt(saltBytes.toString('hex')));
    const verifier = padHex(modPow(g, toBigInt(hashHex(salt + hashed)), N));
    return {
        password,
        Salt: Buffer.from(salt, 'hex').toString('base64'),
        PasswordVerifier: Buffer.from(verifier, 'hex').toString('base64'),
    };
}

export { toBigInt };
