import http from 'node:http';
import { config } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { createApp } from './app.js';

const db = openDb(config.dbPath);
const added = seed(db); // idempotent: adds only what is missing
if (added.units || added.persons || added.document) console.log('Imported registry:', added);

const server = http.createServer(createApp({ db, config }));
server.listen(config.port, config.host, () => console.log(`Alpiki consent registry on http://${config.host}:${config.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
