# crash-demo

A deliberately broken order-report service used to demo [claude-phantom](../../README.md).

`npm start` loads `data/orders.json`, prints a daily report, then starts an HTTP server.
One of the orders (`ord_1003`, a guest checkout) has no `customer` object, so the report
builder crashes on boot with:

```
TypeError: Cannot read properties of undefined (reading 'email')
    at formatOrderLine (src/report.js:9:32)
```

The existing tests in `test/` pass — they only cover orders that have a customer. A good fix
adds a regression test for guest orders and makes `formatOrderLine` tolerate a missing customer.

Run it through phantom from a throwaway git repo:

```sh
npm run demo            # from the claude-phantom repo root
# or manually:
cp -r examples/crash-demo /tmp/crash-demo && cd /tmp/crash-demo
git init -q && git add -A && git commit -qm "demo: initial"
phantom npm start
```
