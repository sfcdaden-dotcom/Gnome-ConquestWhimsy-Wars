// Smoke tests for the Workers-runtime harness itself, and the compatibility
// check on `jose` that PR 2-A owes (ACCOUNTS_SPEC_PHASE_2.md §13): it must run
// in workerd, not only on Node. Sign-in's own verification tests arrive with
// the code that verifies (PR 2-D).

import { createExecutionContext } from 'cloudflare:test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import worker from './index';
import { migrate, testEnv } from './db/d1TestEnv';

describe('the Worker, in the Workers runtime, on local D1', () => {
  it('answers /api/health 200 once the migrations are applied', async () => {
    await migrate();
    const res = await worker.fetch(new Request('http://localhost/api/health'), testEnv as never, createExecutionContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('jose, in the Workers runtime', () => {
  const ISSUER = 'https://accounts.google.com';
  const AUDIENCE = 'client-1';

  async function keys() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
    return { jwks, privateKey };
  }

  function token(claims: Record<string, unknown>, key: CryptoKey) {
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
  }

  const now = () => Math.floor(Date.now() / 1000); // JWT times are seconds
  const options = {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
    requiredClaims: ['exp', 'iat', 'sub'],
  };

  it('verifies an RS256 token signed by a key in the set', async () => {
    const { jwks, privateKey } = await keys();
    const jwt = await token({ iss: ISSUER, aud: AUDIENCE, sub: 'sub-1', iat: now(), exp: now() + 600 }, privateKey);
    expect((await jwtVerify(jwt, jwks, options)).payload.sub).toBe('sub-1');
  });

  it('refuses a wrong audience, and a signature from another key', async () => {
    const { jwks, privateKey } = await keys();
    const other = await keys();
    const claims = { iss: ISSUER, aud: AUDIENCE, sub: 'sub-1', iat: now(), exp: now() + 600 };
    await expect(jwtVerify(await token({ ...claims, aud: 'client-2' }, privateKey), jwks, options)).rejects.toThrow();
    await expect(jwtVerify(await token(claims, other.privateKey), jwks, options)).rejects.toThrow();
  });

  it('refuses a token with no exp only when told exp is required', async () => {
    // Why the spec makes the claims required (§5.2 step 4): by default jose
    // checks exp only if the token has one.
    const { jwks, privateKey } = await keys();
    const jwt = await token({ iss: ISSUER, aud: AUDIENCE, sub: 'sub-1', iat: now() }, privateKey);
    await expect(jwtVerify(jwt, jwks, { algorithms: ['RS256'], issuer: ISSUER, audience: AUDIENCE })).resolves.toBeDefined();
    await expect(jwtVerify(jwt, jwks, options)).rejects.toThrow(/missing required "exp" claim/);
  });
});
