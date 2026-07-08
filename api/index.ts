// Vercel entry: everything under /api/* is routed to this file.
// Exporting a named `fetch` function is Vercel's unambiguous signal to use
// the Web fetch API convention (Request in, Response out). A bare default
// arrow export with a TypeScript type annotation looks like legacy Node
// signature at runtime — TypeScript types are erased before Vercel sees the
// module, so Vercel guesses wrong and waits for res.end() that never comes,
// causing 504 timeouts on every request.
import { app } from '../src/app.js';

export const fetch = app.fetch;
