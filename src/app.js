const express = require('express');
const client = require('prom-client');
const { HttpError } = require('./util');
const productsRouter = require('./products');
const ordersRouter = require('./orders');

const VERSION = process.env.APP_VERSION || 'dev';
const ERROR_RATE = Number(process.env.ERROR_RATE || 0);

const register = new client.Registry();
const requests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});
const latency = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'path'],
  registers: [register],
});

function routeLabel(req) {
  const path = req.route ? req.baseUrl + req.route.path : req.baseUrl;
  return path.replace(/\/$/, '') || 'unmatched';
}

function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use((req, res, next) => {
    const end = latency.startTimer();
    res.on('finish', () => {
      const path = routeLabel(req);
      end({ method: req.method, path });
      requests.inc({ method: req.method, path, status: res.statusCode });
    });
    next();
  });

  const maybeFail = (req, res, next) => {
    if (ERROR_RATE && Math.random() < ERROR_RATE) {
      return res.status(500).json({ error: 'injected failure' });
    }
    next();
  };

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  app.get('/readyz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready', version: VERSION });
    } catch (err) {
      res.status(503).json({ status: 'not ready', error: 'database unavailable' });
    }
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  app.use('/products', maybeFail, productsRouter(pool));
  app.use('/orders', maybeFail, ordersRouter(pool));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.code === '23503') {
      return res.status(409).json({ error: 'resource is referenced by other records' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = createApp;
