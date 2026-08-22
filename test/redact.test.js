'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/redact');

const cases = [
  ['env assignment', 'DATABASE_URL=postgres://u:p@h/db API_KEY=abcd1234efgh', /API_KEY=\[REDACTED\]/],
  ['url creds', 'connecting to postgres://user:hunter2@db.internal/app', /postgres:\/\/user:\[REDACTED\]@db\.internal/],
  ['json field', '{"password": "s3cretvalue", "user": "bob"}', /"password": "\[REDACTED\]"/],
  ['bearer header', 'authorization: Bearer abc.def.ghi.jkl123456', /authorization: \[REDACTED\]/],
  ['anthropic key', 'using key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa', /\[REDACTED\]/],
  ['github pat', 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', /\[REDACTED\]/],
  ['aws key', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE', /\[REDACTED\]/],
  ['jwt', 'cookie: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', /\[REDACTED/],
  ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', /\[REDACTED-PRIVATE-KEY\]/],
];

for (const [name, input, expected] of cases) {
  test(`redacts ${name}`, () => {
    const { text, redactions } = redact(input);
    assert.match(text, expected);
    assert.ok(redactions >= 1);
  });
}

test('leaves ordinary stack traces intact', () => {
  const trace = 'TypeError: Cannot read properties of undefined (reading \'email\')\n    at formatOrderLine (/app/src/report.js:8:32)\n    at Array.map (<anonymous>)';
  const { text, redactions } = redact(trace);
  assert.equal(text, trace);
  assert.equal(redactions, 0);
});

test('handles empty input', () => {
  assert.deepEqual(redact(''), { text: '', redactions: 0 });
  assert.deepEqual(redact(null), { text: '', redactions: 0 });
});

test('Authorization headers are redacted whole, not just the scheme word', () => {
  // `auth` is one of KEY_NAMES, so the generic KEY=value rule matched
  // "Authorization: " and treated the SCHEME as the secret -- producing
  // "Authorization: [REDACTED] sk0pq7Rt...", which scrubbed the one part that
  // was never sensitive and published the token. The dedicated header rule
  // below it could then never fire, because its anchor word was already gone.
  // Ordering is the fix, so these assertions pin the order.
  const cases = [
    'Authorization: Bearer sk0pq7RtYvWx2Zm4Nb8Kd1Lf6Hj3Gc5A',
    'authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l',
    'Proxy-Authorization: Bearer OpaqueTok123456789',
    '{"Authorization":"Bearer AbCdEfGhIjKlMnOp"}',
    'Authorization=Digest abcdef0123456789',
  ];
  for (const input of cases) {
    const { text } = redact(input);
    assert.match(text, /\[REDACTED\]/, input);
    for (const token of ['sk0pq7RtYvWx2Zm4Nb8Kd1Lf6Hj3Gc5A', 'YWxhZGRpbjpvcGVuc2VzYW1l', 'OpaqueTok123456789', 'AbCdEfGhIjKlMnOp', 'abcdef0123456789']) {
      assert.ok(!text.includes(token), 'token survived in: ' + text);
    }
  }
});

test('credentials in a URL query string and quoted multi-word values are caught', () => {
  // The generic rule's prefix class starts at whitespace or a quote, so it
  // never fired on `?` or `&` -- and a failed HTTP request logging its full URL
  // is the most common shape a crash tail takes. A quoted value was also cut at
  // the first space, redacting one word of a passphrase and printing the rest.
  const checks = [
    ['GET https://api.example.com/v1/users?api_key=AKfycbx9QeR2vT7pLmN3&limit=10', 'AKfycbx9QeR2vT7pLmN3'],
    ['request to https://x.io/cb?access_token=ya29.a0AfB_bZk3Qw9r7Tn failed', 'ya29.a0AfB_bZk3Qw9r7Tn'],
    ['DB_PASSWORD: "horse battery staple"', 'battery staple'],
    ['export STRIPE=sk_live_51H8xQwABCDEFGHIJKLMNOP', 'sk_live_51H8xQwABCDEFGHIJKLMNOP'],
  ];
  for (const [input, secret] of checks) {
    const { text } = redact(input);
    assert.ok(!text.includes(secret), 'leaked "' + secret + '" from: ' + text);
    assert.match(text, /\[REDACTED\]/, input);
  }
  // Non-secret query parameters are left alone, so the URL stays diagnosable.
  assert.match(redact('GET /v1/users?api_key=AKfycbx9QeR2vT7pLmN3&limit=10').text, /&limit=10$/);
});
