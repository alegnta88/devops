class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 does not catch rejected promises, so wrap async handlers.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const toInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};

// Parse ?limit= and ?offset= safely.
function paging(query) {
  return {
    limit: Math.min(Math.max(toInt(query.limit, 50), 1), 100),
    offset: Math.min(Math.max(toInt(query.offset, 0), 0), 1e9),
  };
}

module.exports = { HttpError, wrap, isUuid, isInt, paging, EMAIL_RE };
