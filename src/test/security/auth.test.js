import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidApiKey,
  generateToken,
  verifyToken,
  createAuthenticator
} from '../../security/auth.js';

function fakeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return {
    logs,
    info: (msg) => logs.info.push(msg),
    warn: (msg) => logs.warn.push(msg),
    error: (msg) => logs.error.push(msg)
  };
}

test('isValidApiKey returns true for a key in the configured list', () => {
  assert.equal(isValidApiKey('dev-key-123', ['dev-key-123', 'other-key']), true);
});

test('isValidApiKey returns false for a key not in the list', () => {
  assert.equal(isValidApiKey('wrong-key', ['dev-key-123']), false);
});

test('isValidApiKey returns false for missing header value', () => {
  assert.equal(isValidApiKey(undefined, ['dev-key-123']), false);
});

test('generateToken + verifyToken round-trips a valid, unexpired token', () => {
  const token = generateToken({ sub: 'user-1' }, 'secret', 3600);
  const result = verifyToken(token, 'secret');

  assert.equal(result.valid, true);
  assert.equal(result.reason, 'token');
  assert.equal(result.payload.sub, 'user-1');
});

test('verifyToken rejects a token signed with a different secret', () => {
  const token = generateToken({ sub: 'user-1' }, 'secret-a', 3600);
  const result = verifyToken(token, 'secret-b');

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid');
});

test('verifyToken rejects an expired token', () => {
  const token = generateToken({ sub: 'user-1' }, 'secret', -1);
  const result = verifyToken(token, 'secret');

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('verifyToken rejects a malformed token', () => {
  assert.equal(verifyToken('not-a-token', 'secret').valid, false);
  assert.equal(verifyToken('', 'secret').valid, false);
  assert.equal(verifyToken(null, 'secret').valid, false);
});

test('authenticate allows a route that does not require auth, with no header at all', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: false
  });

  const result = auth.authenticate({}, undefined);

  assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'not_required');
});

test('authenticate denies a required route with a missing header', () => {
  const logger = fakeLogger();
  const auth = createAuthenticator(
    { headerName: 'X-API-Key', keys: ['dev-key-123'], requiredByDefault: true },
    logger
  );

  const result = auth.authenticate({}, undefined, '/api');

  assert.equal(result.authenticated, false);
  assert.equal(result.reason, 'missing');
  assert.equal(logger.logs.info.length, 1);
  assert.match(logger.logs.info[0], /missing/);
});

test('authenticate accepts a valid API key via lowercased header lookup', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true
  });

  const result = auth.authenticate({ 'x-api-key': 'dev-key-123' }, undefined);

  assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'api_key');
});

test('authenticate denies an invalid API key when no hmacSecret is configured', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true
  });

  const result = auth.authenticate({ 'x-api-key': 'wrong-key' }, undefined);

  assert.equal(result.authenticated, false);
  assert.equal(result.reason, 'invalid');
});

test('authenticate falls back to token verification when API key does not match', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true,
    hmacSecret: 'secret',
    tokenExpirySeconds: 3600
  });

  const token = auth.issueToken({ sub: 'user-1' });
  const result = auth.authenticate({ 'x-api-key': token }, undefined);

  assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'token');
});

test('authenticate reports expired as the reason for an expired token', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true,
    hmacSecret: 'secret',
    tokenExpirySeconds: -1
  });

  const token = auth.issueToken({ sub: 'user-1' });
  const result = auth.authenticate({ 'x-api-key': token }, undefined);

  assert.equal(result.authenticated, false);
  assert.equal(result.reason, 'expired');
});

test('authenticate respects a per-route boolean override', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true
  });

  const result = auth.authenticate({}, false);

  assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'not_required');
});

test('authenticate respects a per-route object override with required: false', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true
  });

  const result = auth.authenticate({}, { required: false });

  assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'not_required');
});

test('authenticate respects a per-route object override with required: true on an otherwise open route', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: false
  });

  const result = auth.authenticate({}, { required: true });

  assert.equal(result.authenticated, false);
  assert.equal(result.reason, 'missing');
});

test('issueToken throws when hmacSecret is not configured', () => {
  const auth = createAuthenticator({
    headerName: 'X-API-Key',
    keys: ['dev-key-123'],
    requiredByDefault: true
  });

  assert.throws(() => auth.issueToken({ sub: 'user-1' }), /hmacSecret/);
});

test('authenticate does not leak the failure reason into the returned reason for a generic caller check', () => {
  const logger = fakeLogger();
  const auth = createAuthenticator(
    { headerName: 'X-API-Key', keys: ['dev-key-123'], requiredByDefault: true },
    logger
  );

  const result = auth.authenticate({ 'x-api-key': 'bad' }, undefined, '/admin');

  assert.equal(result.authenticated, false);
  assert.match(logger.logs.info[0], /invalid/);
  assert.match(logger.logs.info[0], /\/admin/);
});