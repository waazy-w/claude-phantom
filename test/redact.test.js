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
