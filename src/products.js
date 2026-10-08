const express = require('express');
const { HttpError, wrap, isUuid, isInt, paging } = require('./util');

const COLUMNS = 'id, name, description, price_cents, stock, created_at';
const MAX_PRICE = 100_000_000; // 1,000,000.00 in cents
const MAX_STOCK = 1_000_000;

function parseProduct(body) {
  const { name, description = '', price_cents, stock } = body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    throw new HttpError(422, 'name is required (max 200 characters)');
  }
  if (typeof description !== 'string' || description.length > 2000) {
    throw new HttpError(422, 'description must be a string (max 2000 characters)');
  }
  if (!isInt(price_cents, 0, MAX_PRICE)) {
    throw new HttpError(422, `price_cents must be an integer between 0 and ${MAX_PRICE}`);
  }
  if (!isInt(stock, 0, MAX_STOCK)) {
    throw new HttpError(422, `stock must be an integer between 0 and ${MAX_STOCK}`);
  }
  return { name: name.trim(), description, price_cents, stock };
}

module.exports = function productsRouter(pool) {
  const router = express.Router();

  router.get('/', wrap(async (req, res) => {
    const { limit, offset } = paging(req.query);
    const r = await pool.query(
      `SELECT ${COLUMNS} FROM products ORDER BY created_at, id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(r.rows);
  }));

  router.get('/:id', wrap(async (req, res) => {
    const r = isUuid(req.params.id)
      ? await pool.query(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [req.params.id])
      : { rows: [] };
    if (!r.rows[0]) throw new HttpError(404, 'product not found');
    res.json(r.rows[0]);
  }));

  router.post('/', wrap(async (req, res) => {
    const p = parseProduct(req.body);
    const r = await pool.query(
      `INSERT INTO products (name, description, price_cents, stock)
       VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [p.name, p.description, p.price_cents, p.stock]
    );
    res.status(201).json(r.rows[0]);
  }));

  router.put('/:id', wrap(async (req, res) => {
    const p = parseProduct(req.body);
    const r = isUuid(req.params.id)
      ? await pool.query(
          `UPDATE products SET name = $1, description = $2, price_cents = $3, stock = $4
           WHERE id = $5 RETURNING ${COLUMNS}`,
          [p.name, p.description, p.price_cents, p.stock, req.params.id]
        )
      : { rows: [] };
    if (!r.rows[0]) throw new HttpError(404, 'product not found');
    res.json(r.rows[0]);
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const r = isUuid(req.params.id)
      ? await pool.query('DELETE FROM products WHERE id = $1', [req.params.id])
      : { rowCount: 0 };
    if (!r.rowCount) throw new HttpError(404, 'product not found');
    res.status(204).end();
  }));

  return router;
};
