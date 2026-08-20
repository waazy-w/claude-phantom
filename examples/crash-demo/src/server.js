'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildReport } = require('./report');

const PORT = process.env.PORT || 3000;
const ordersPath = path.join(__dirname, '..', 'data', 'orders.json');

function loadOrders() {
  return JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
}

console.log('[demo] loading orders from data/orders.json');
const orders = loadOrders();
console.log(`[demo] ${orders.length} orders loaded`);

console.log('[demo] building daily report...');
const report = buildReport(orders);
console.log(report);

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/plain');
  res.end(buildReport(loadOrders()) + '\n');
});

server.listen(PORT, () => {
  console.log(`[demo] report server listening on http://localhost:${PORT}`);
});
