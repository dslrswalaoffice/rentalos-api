// Vercel entry: everything under /api/* is routed to this file.
// The Hono app is defined in ../src/app.ts and reused unchanged by scripts/dev.ts.
import { handle } from 'hono/vercel';
import { app } from '../src/app.js';

export const config = {
  runtime: 'nodejs',
};

export default handle(app);
