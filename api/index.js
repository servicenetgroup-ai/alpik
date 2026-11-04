// Vercel serverless entry: all /api/* requests are rewritten here (see vercel.json).
// Static files are served by Vercel from /public.
import { createApp } from '../src/app.js';
import { getDb } from '../src/bootstrap.js';
import { config } from '../src/config.js';

const handler = createApp({ db: () => getDb(config), config, serveStatic: false });
export default handler;
