// Plain Node server for local development or any non-serverless host.
import http from 'node:http';
import { config } from './config.js';
import { getDb } from './bootstrap.js';
import { createApp } from './app.js';

if (!config.databaseUrl) { console.error('Set DATABASE_URL (PostgreSQL connection string).'); process.exit(1); }
await getDb(config);
const server = http.createServer(createApp({ db: () => getDb(config), config }));
server.listen(config.port, config.host, () => console.log(`Alpiki consent registry on http://${config.host}:${config.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(async () => { (await getDb(config)).close(); process.exit(0); }));
