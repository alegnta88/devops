const express = require('express');
const { HttpError, wrap, isUuid, isInt, paging, EMAIL_RE } = require('./util');
const { withTx } = require('./db');

const STATUSES = ['pending', 'paid', 'cancelled'];

async function loadOrder(db, id) {
  if (!isUuid(id)) return null;
  const o = await db.query(
    'SELECT id, customer_email, status, total_cents, created_at FROM orders WHERE id = $1',
    [id]
  );
  if (!o.rows[0]) return null;
  const items = await db.query(
    'SELECT product_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY id',
    [id]
  );
  return { ...o.rows[0], items: items.rows };
}

function parseOrder(body) {
  const { customer_email, items } = body || {};
  if (typeof customer_email !== 'string' || customer_email.length > 254 || !EMAIL_RE.test(customer_email)) {
    throw new HttpError(422, 'a valid customer_email is required');
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    throw new HttpError(422, 'items must be an array of 1 to 50 entries');
  }
  const seen = new Set();
  for (const it of items) {
    if (!it || !isUuid(it.product_id) || !isInt(it.quantity, 1, 1000)) {
      throw new HttpError(422, 'each item needs a product_id (uuid) and a quantity (integer 1-1000)');
    }
    if (seen.has(it.product_id)) throw new HttpError(422, 'duplicate product_id in items');
    seen.add(it.product_id);
  }
  return { customer_email: customer_email.toLowerCase(), items };
}

module.exports = function ordersRouter(pool) {
  const router = express.Router();

  async function explainFailure(id, verb) {
    const existing = await loadOrder(pool, id);
    if (!existing) throw new HttpError(404, 'order not found');
    throw new HttpError(409, `order is ${existing.status}; only pending orders can be ${verb}`);
  }

  router.post('/', wrap(async (req, res) => {
    const { customer_email, items } = parseOrder(req.body);

    const orderId = await withTx(pool, async (tx) => {
      const found = await tx.query(
        'SELECT id, price_cents, stock FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [items.map((i) => i.product_id)]
      );
      const products = new Map(found.rows.map((p) => [p.id, p]));

      let total = 0;
      for (const it of items) {
        const p = products.get(it.product_id);
        if (!p) throw new HttpError(422, `unknown product ${it.product_id}`);
        if (p.stock < it.quantity) {
          throw new HttpError(409, `insufficient stock for product ${it.product_id}`);
        }
        total += p.price_cents * it.quantity;
      }

      const order = await tx.query(
        'INSERT INTO orders (customer_email, total_cents) VALUES ($1, $2) RETURNING id',
        [customer_email, total]
      );
      const id = order.rows[0].id;

      for (const it of items) {
        const p = products.get(it.product_id);
        await tx.query(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)',
          [id, it.product_id, it.quantity, p.price_cents]
        );
        await tx.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [it.quantity, it.product_id]);
      }
      return id;
    });

    res.status(201).json(await loadOrder(pool, orderId));
  }));

  router.get('/', wrap(async (req, res) => {
    const { limit, offset } = paging(req.query);
    const { status, customer_email } = req.query;
    const where = [];
    const params = [];

    if (status !== undefined) {
      if (!STATUSES.includes(status)) {
        throw new HttpError(422, `status must be one of: ${STATUSES.join(', ')}`);
      }
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (typeof customer_email === 'string') {
      params.push(customer_email.toLowerCase());
      where.push(`customer_email = $${params.length}`);
    }
    params.push(limit, offset);

    const sql = `
      SELECT id, customer_email, status, total_cents, created_at FROM orders
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC, id
      LIMIT $${params.length - 1} OFFSET $${params.length}`;
    res.json((await pool.query(sql, params)).rows);
  }));

  router.get('/:id', wrap(async (req, res) => {
    const order = await loadOrder(pool, req.params.id);
    if (!order) throw new HttpError(404, 'order not found');
    res.json(order);
  }));

  router.post('/:id/pay', wrap(async (req, res) => {
    const { id } = req.params;
    if (isUuid(id)) {
      const r = await pool.query(
        "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'",
        [id]
      );
      if (r.rowCount) return res.json(await loadOrder(pool, id));
    }
    return explainFailure(id, 'paid');
  }));

  router.post('/:id/cancel', wrap(async (req, res) => {
    const { id } = req.params;
    const cancelled =
      isUuid(id) &&
      (await withTx(pool, async (tx) => {
        const r = await tx.query(
          "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'",
          [id]
        );
        if (!r.rowCount) return false;
        // Lock in the same order as order creation, then put the reserved stock back.
        await tx.query(
          `SELECT 1 FROM products
           WHERE id IN (SELECT product_id FROM order_items WHERE order_id = $1)
           ORDER BY id FOR UPDATE`,
          [id]
        );
        await tx.query(
          `UPDATE products p SET stock = p.stock + oi.quantity
           FROM order_items oi
           WHERE oi.order_id = $1 AND oi.product_id = p.id`,
          [id]
        );
        return true;
      }));
    if (cancelled) return res.json(await loadOrder(pool, id));
    return explainFailure(id, 'cancelled');
  }));

  return router;
};
