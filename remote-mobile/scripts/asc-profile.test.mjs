import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { apiToken, pickProfile, PROFILE_NAME } from './asc-profile.mjs';

const profile = (id, { name = PROFILE_NAME, state = 'ACTIVE', expires = '2027-01-01', certs = ['C1'] } = {}) => ({
  id, attributes: { name, profileState: state, expirationDate: expires }, certificateIds: certs,
});

test('reuses the newest active profile that carries the current certificate', () => {
  const picked = pickProfile([
    profile('old', { expires: '2026-12-01' }),
    profile('new', { expires: '2027-06-01' }),
    profile('expired', { state: 'INVALID', expires: '2028-01-01' }),
    profile('other-cert', { certs: ['C2'], expires: '2029-01-01' }),
    profile('other-name', { name: 'Something else', expires: '2029-01-01' }),
  ], 'C1');
  assert.equal(picked.id, 'new');
});

test('asks for a new profile when none carries the current certificate', () => {
  assert.equal(pickProfile([profile('a', { certs: ['C2'] })], 'C1'), undefined);
});

test('signs an ES256 App Store Connect token that verifies with the key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = apiToken({ keyId: 'KEY123', issuerId: 'issuer-uuid', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 1000);
  const [header, payload, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'issuer-uuid', iat: 1000, exp: 1600, aud: 'appstoreconnect-v1' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});
