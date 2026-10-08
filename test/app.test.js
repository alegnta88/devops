const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const createApp = require('../src/app');
const { createPool, initSchema } = require('../src/db');

const DATABASE_URL = process.env.DATABASE_URL;
const needsDb = { skip: !DATABASE_URL && 'DATABASE_URL not set' };

let server;
let base;
let pool;

before(async () => {
  if (DATABASE_URL) {
    pool = createPool(DATABASE_URL);
    await initSchema(pool);
  }
  await new Promise((resolve) => {
    server = createApp(pool).listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  if (pool) await pool.end();
});

const api = (path, { method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });

const newProduct = async (stock = 5) =>
  (await api('/products', { method: 'POST', body: { name: 'Mug', price_cents: 1500, stock } })).json();

const placeOrder = (productId, quantity) =>
  api('/orders', {
    method: 'POST',
    body: { customer_email: 'Ann@Example.com', items: [{ product_id: productId, quantity }] },
  });

const stockOf = async (id) => (await (await api(`/products/${id}`)).json()).stock;

// --- These run without a database -------------------------------------------

test('health and metrics', async () => {
  assert.equal((await api('/healthz')).status, 200);
  const text = await (await api('/metrics')).text();
  assert.match(text, /http_requests_total/);
});

test('product validation rejects bad input', async () => {
  const res = await api('/products', { method: 'POST', body: { name: '', price_cents: -1, stock: 1 } });
  assert.equal(res.status, 422);
});

test('order validation rejects bad input', async () => {
  const res = await api('/orders', { method: 'POST', body: { customer_email: 'nope', items: [] } });
  assert.equal(res.status, 422);
});

// --- These need Postgres (set DATABASE_URL) ----------------------------------

test('product CRUD', needsDb, async () => {
  const p = await newProduct();
  assert.equal(p.stock, 5);

  const upd = await api(`/products/${p.id}`, {
    method: 'PUT',
    body: { name: 'Big Mug', price_cents: 2000, stock: 7 },
  });
  assert.equal((await upd.json()).name, 'Big Mug');

  assert.equal((await api(`/products/${p.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/products/${p.id}`)).status, 404);
});

test('ordering reserves stock, paying works, paid orders cannot be cancelled', needsDb, async () => {
  const p = await newProduct(5);
  const res = await placeOrder(p.id, 2);
  assert.equal(res.status, 201);

  const order = await res.json();
  assert.equal(order.status, 'pending');
  assert.equal(order.total_cents, 3000);
  assert.equal(order.customer_email, 'ann@example.com');
  assert.equal(await stockOf(p.id), 3);

  const paid = await api(`/orders/${order.id}/pay`, { method: 'POST' });
  assert.equal((await paid.json()).status, 'paid');

  assert.equal((await api(`/orders/${order.id}/cancel`, { method: 'POST' })).status, 409);
  assert.equal((await api(`/orders/${order.id}/pay`, { method: 'POST' })).status, 409);
});

test('cancelling a pending order restores stock', needsDb, async () => {
  const p = await newProduct(5);
  const order = await (await placeOrder(p.id, 4)).json();
  assert.equal(await stockOf(p.id), 1);

  const cancelled = await api(`/orders/${order.id}/cancel`, { method: 'POST' });
  assert.equal((await cancelled.json()).status, 'cancelled');
  assert.equal(await stockOf(p.id), 5);
});

test('ordering more than the available stock is refused', needsDb, async () => {
  const p = await newProduct(2);
  assert.equal((await placeOrder(p.id, 3)).status, 409);
  assert.equal(await stockOf(p.id), 2);
});

test('a product that appears in an order cannot be deleted', needsDb, async () => {
  const p = await newProduct(5);
  await placeOrder(p.id, 1);
  assert.equal((await api(`/products/${p.id}`, { method: 'DELETE' })).status, 409);
});
