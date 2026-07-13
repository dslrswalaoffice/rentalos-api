import { createMiddleware } from 'hono/factory';
import { trackEvent } from '../lib/web-analytics.js';

/**
 * Middleware to track API requests with Vercel Web Analytics.
 * This provides visibility into API usage patterns, endpoint popularity,
 * and response times.
 * 
 * Note: This middleware tracks events asynchronously and doesn't block requests.
 * Analytics failures are logged but don't affect the API response.
 */
export const analyticsMiddleware = createMiddleware(async (c, next) => {
  const startTime = Date.now();
  const path = c.req.path;
  const method = c.req.method;

  // Execute the request
  await next();

  // Track the request asynchronously (fire-and-forget)
  const duration = Date.now() - startTime;
  const status = c.res.status;

  // Track API request event with metadata
  trackEvent('API Request', {
    method,
    path,
    status,
    duration,
    success: status >= 200 && status < 400,
  }).catch(() => {
    // Already handled in trackEvent, this is just for safety
  });
});
