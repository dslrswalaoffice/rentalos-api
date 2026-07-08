// Vercel entry: everything under /api/* is routed to this file.
// Export app.fetch directly (Web fetch API) — Vercel's Node runtime
// routes requests through it and handles the returned Response correctly.
// Do NOT wrap in `handle()` — that adapter maps to a legacy Vercel signature
// which now silently 504s.
import { app } from '../src/app.js';

export default (request: Request) => app.fetch(request);
