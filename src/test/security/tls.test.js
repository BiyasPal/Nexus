import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import cp from 'node:child_process';
import https from 'node:https';

import {
  isOpensslAvailable,
  opensslManualCommand,
  ensureCertificate,
  loadTlsContext,
  getCertExpiry,
  warnIfExpiringSoon,
  createHttpsServer
} from '../../security/tls.js';

test('isOpensslAvailable returns true when execFileSync succeeds', (t) => {
  t.mock.method(cp, 'execFileSync', () => Buffer.from('OpenSSL 3.0.0'));
  assert.equal(isOpensslAvailable(), true);
});

test('isOpensslAvailable returns false when execFileSync throws', (t) => {
  t.mock.method(cp, 'execFileSync', () => {
    throw new Error('not found');
  });
  assert.equal(isOpensslAvailable(), false);
});

test('opensslManualCommand includes both paths and a valid subject', () => {
  const cmd = opensslManualCommand('/certs/cert.pem', '/certs/key.pem');
  assert.match(cmd, /openssl req -x509/);
  assert.match(cmd, /\/certs\/cert\.pem/);
  assert.match(cmd, /\/certs\/key\.pem/);
  assert.match(cmd, /-subj "\/CN=localhost"/);
});

test('ensureCertificate does nothing when cert and key already exist', (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  const execSyncMock = t.mock.method(cp, 'execSync', () => Buffer.from(''));
  const result = ensureCertificate('./certs/cert.pem', './certs/key.pem');
  assert.deepEqual(result, { generated: false });
  assert.equal(execSyncMock.mock.callCount(), 0);
});

test('ensureCertificate generates a cert when files are missing and openssl is available', (t) => {
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'mkdirSync', () => undefined);
  t.mock.method(cp, 'execFileSync', () => Buffer.from('OpenSSL 3.0.0'));
  const execSyncMock = t.mock.method(cp, 'execSync', () => Buffer.from(''));
  const result = ensureCertificate('./certs/cert.pem', './certs/key.pem');
  assert.deepEqual(result, { generated: true });
  assert.equal(execSyncMock.mock.callCount(), 1);
  assert.match(execSyncMock.mock.calls[0].arguments[0], /openssl req -x509/);
});

test('ensureCertificate throws with the exact manual command when openssl is missing', (t) => {
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(cp, 'execFileSync', () => {
    throw new Error('command not found');
  });
  assert.throws(
    () => ensureCertificate('./certs/cert.pem', './certs/key.pem'),
    (err) => {
      assert.match(err.message, /openssl not found on PATH/);
      assert.match(err.message, /openssl req -x509/);
      assert.match(err.message, /certs\/cert\.pem/);
      assert.match(err.message, /certs\/key\.pem/);
      return true;
    }
  );
});

test('loadTlsContext reads cert and key files into buffers', (t) => {
  t.mock.method(fs, 'readFileSync', (filePath) => Buffer.from(`content:${filePath}`));
  const { cert, key } = loadTlsContext('./certs/cert.pem', './certs/key.pem');
  assert.equal(cert.toString(), 'content:./certs/cert.pem');
  assert.equal(key.toString(), 'content:./certs/key.pem');
});

test('getCertExpiry parses the notAfter date from openssl output', (t) => {
  t.mock.method(cp, 'execFileSync', () => Buffer.from('notAfter=Dec 31 23:59:59 2099 GMT\n'));
  const expiry = getCertExpiry('./certs/cert.pem');
  assert.ok(expiry instanceof Date);
  assert.equal(expiry.getUTCFullYear(), 2099);
});

test('getCertExpiry returns null when output cannot be parsed', (t) => {
  t.mock.method(cp, 'execFileSync', () => Buffer.from('unexpected output'));
  assert.equal(getCertExpiry('./certs/cert.pem'), null);
});

test('warnIfExpiringSoon logs a warning when the cert expires within the threshold', (t) => {
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  t.mock.method(cp, 'execFileSync', () => Buffer.from(`notAfter=${soon.toUTCString()}\n`));
  const warnCalls = [];
  const logger = { warn: (msg) => warnCalls.push(msg) };
  const days = warnIfExpiringSoon('./certs/cert.pem', 7, logger);
  assert.equal(warnCalls.length, 1);
  assert.match(warnCalls[0], /expires in/);
  assert.ok(days <= 7);
});

test('warnIfExpiringSoon stays quiet when the cert is not close to expiry', (t) => {
  const farFuture = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000);
  t.mock.method(cp, 'execFileSync', () => Buffer.from(`notAfter=${farFuture.toUTCString()}\n`));
  const warnCalls = [];
  const logger = { warn: (msg) => warnCalls.push(msg) };
  warnIfExpiringSoon('./certs/cert.pem', 7, logger);
  assert.equal(warnCalls.length, 0);
});

test('createHttpsServer ensures the certificate then builds an https server with cert and key', (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'readFileSync', (filePath) => Buffer.from(`content:${filePath}`));
  const createServerMock = t.mock.method(https, 'createServer', (options, handler) => ({ options, handler }));
  const handler = () => {};
  const server = createHttpsServer(handler, './certs/cert.pem', './certs/key.pem');
  assert.equal(createServerMock.mock.callCount(), 1);
  const [options, passedHandler] = createServerMock.mock.calls[0].arguments;
  assert.equal(passedHandler, handler);
  assert.equal(options.cert.toString(), 'content:./certs/cert.pem');
  assert.equal(options.key.toString(), 'content:./certs/key.pem');
  assert.equal(options.SNICallback, undefined);
  assert.ok(server);
});

test('createHttpsServer wires an SNICallback when a hostname map is provided', (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'readFileSync', (filePath) => Buffer.from(`content:${filePath}`));
  t.mock.method(https, 'createServer', (options) => ({ options }));
  const server = createHttpsServer(() => {}, './certs/cert.pem', './certs/key.pem', {
    sni: { 'a.example.com': { certPath: './a-cert.pem', keyPath: './a-key.pem' } }
  });
  assert.equal(typeof server.options.SNICallback, 'function');
});