// Applies migrations and imports the registry without touching existing data.
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
const db = openDb(config.dbPath);
console.log('Database:', config.dbPath);
console.log('Added:', seed(db));
db.close();
