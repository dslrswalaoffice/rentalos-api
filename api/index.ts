// Vercel entry point using the classic Serverless Function convention.
// Named HTTP method exports (GET, POST, etc.) tell Vercel's runtime unambiguously
// to use the Web Fetch API signature — no signature guessing, no 504s.
// Ref: https://vercel.com/docs/frameworks/backend/hono
import { handle } from 'hono/vercel';
import { app } from '../src/app.js';

export const GET     = handle(app);
export const POST    = handle(app);
export const PATCH   = handle(app);
export const PUT     = handle(app);
export const DELETE  = handle(app);
export const OPTIONS = handle(app);
