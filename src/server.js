const createApp = require('./app');
const { createPool, initSchema } = require('./db');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const pool = createPool(url);
  await initSchema(pool); // fail fast if the database is unreachable
  console.log('connected to postgres');

  const port = process.env.PORT || 8080;
  const server = createApp(pool).listen(port, () => {
    console.log(`orders-api listening on ${port}`);
  });

  // Graceful shutdown: Kubernetes sends SIGTERM before killing the pod.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${signal} received, shutting down`);
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error('startup failed:', err.message);
  process.exit(1);
});
