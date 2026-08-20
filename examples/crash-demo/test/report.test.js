'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderTotal, formatOrderLine, buildReport } = require('../src/report');

const ada = {
  id: 'ord_1',
  customer: { name: 'Ada', email: 'ada@example.com' },
  items: [{ sku: 'A', qty: 2, price: 1.25 }],
};

test('orderTotal sums qty * price', () => {
  assert.equal(orderTotal(ada), 2.5);
});

test('orderTotal of an empty order is 0', () => {
  assert.equal(orderTotal({ ...ada, items: [] }), 0);
});

test('formatOrderLine includes id, email and total', () => {
  const line = formatOrderLine(ada);
  assert.match(line, /^ord_1\s+ada@example\.com\s+\$2\.50$/);
});

test('buildReport ends with a grand total', () => {
  const out = buildReport([ada, ada]);
  assert.match(out, /TOTAL {2}\$5\.00$/);
});
