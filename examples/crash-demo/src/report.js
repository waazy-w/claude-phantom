'use strict';

function orderTotal(order) {
  return order.items.reduce((sum, item) => sum + item.qty * item.price, 0);
}

function formatOrderLine(order) {
  const email = order.customer.email;
  const total = orderTotal(order).toFixed(2);
  return `${order.id}  ${email.padEnd(24)} $${total}`;
}

function buildReport(orders) {
  const lines = orders.map(formatOrderLine);
  const grand = orders.reduce((sum, o) => sum + orderTotal(o), 0);
  return [...lines, '', `TOTAL  $${grand.toFixed(2)}`].join('\n');
}

module.exports = { orderTotal, formatOrderLine, buildReport };
