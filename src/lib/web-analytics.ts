// Vercel Web Analytics for server-side event tracking
// Ref: https://vercel.com/docs/analytics/custom-events
import { track } from '@vercel/analytics/server';

/**
 * Track a custom event with Vercel Web Analytics.
 * This function wraps the Vercel analytics track function to provide
 * error handling and type safety for server-side event tracking.
 * 
 * @param eventName - Name of the event to track (max 255 characters)
 * @param data - Optional data to attach to the event (strings, numbers, booleans, or null)
 * 
 * Note: Custom event tracking is available for Pro and Enterprise Vercel users.
 * Events are tracked server-side and don't require client-side JavaScript.
 */
export async function trackEvent(
  eventName: string,
  data?: Record<string, string | number | boolean | null>
): Promise<void> {
  try {
    await track(eventName, data);
  } catch (error) {
    // Log but don't throw - analytics failures shouldn't break the API
    console.error('[web-analytics] Failed to track event:', eventName, error);
  }
}

/**
 * Re-export the raw track function for advanced use cases.
 */
export { track };
