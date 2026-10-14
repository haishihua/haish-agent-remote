import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePairingUri, validateStoredConnection } from '../src/pairing-uri.js';

test('parses the single supported Haish pairing URI format', () => {
  assert.deepEqual(
    parsePairingUri('haish://pair?v=1&endpoint=https%3A%2F%2Fremote.example.com&code=12345678'),
    { endpoint: 'https://remote.example.com', code: '12345678' },
  );
});

test('rejects insecure and non-canonical pairing endpoints', () => {
  assert.throws(
    () => parsePairingUri('haish://pair?v=1&endpoint=http%3A%2F%2Fremote.example.com&code=12345678'),
    /secure HTTPS origin/,
  );
  assert.throws(
    () => parsePairingUri('haish://pair?v=1&endpoint=https%3A%2F%2Fexample.com%2Fremote&code=12345678'),
    /secure HTTPS origin/,
  );
  assert.throws(
    () => parsePairingUri('https://example.com/?code=12345678'),
    /not a Haish pairing QR code/,
  );
});

test('rejects unsupported versions, fields, and pairing codes', () => {
  assert.throws(
    () => parsePairingUri('haish://pair?v=2&endpoint=https%3A%2F%2Fexample.com&code=12345678'),
    /version is not supported/,
  );
  assert.throws(
    () => parsePairingUri('haish://pair?v=1&endpoint=https%3A%2F%2Fexample.com&code=1234'),
    /invalid pairing code/,
  );
  assert.throws(
    () => parsePairingUri('haish://pair?v=1&endpoint=https%3A%2F%2Fexample.com&code=12345678&legacy=1'),
    /unsupported or duplicate fields/,
  );
  assert.throws(
    () => parsePairingUri('haish://pair?v=1&endpoint=https%3A%2F%2Fexample.com&code=12345678&code=87654321'),
    /unsupported or duplicate fields/,
  );
});

test('validates persisted native connections', () => {
  const token = 'a'.repeat(43);
  assert.deepEqual(validateStoredConnection({ endpoint: 'https://remote.example.com', token }), {
    endpoint: 'https://remote.example.com',
    token,
  });
  assert.equal(validateStoredConnection({ endpoint: 'http://remote.example.com', token }), null);
  assert.equal(validateStoredConnection({ endpoint: 'https://remote.example.com', token: 'short' }), null);
});
