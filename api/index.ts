// Vercel entry: everything under /api/* is routed to this file.
// The Hono app is defined in ../src/app.ts.
import { handle } from 'hono/vercel';
import { app } from '../src/app.js';

export default handle(app);
