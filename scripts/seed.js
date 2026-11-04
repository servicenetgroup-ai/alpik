// Applies migrations and imports the registry without touching existing data.
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
const db = await openDb(config.databaseUrl);
console.log('Added:', await seed(db, { force: true }));
await db.close();
