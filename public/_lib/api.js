// public/_lib/api.js
// ============================================================================
// Thin fetch wrapper for RentalOS frontend pages. Same-origin only, includes
// cookies automatically, throws structured errors, provides an ensureAuth()
// helper that redirects to sign-in if the caller isn't authenticated.
//
// Usage from any page:
//   import { api, ensureAuth, formatINR, rupeesToPaise, paiseToRupees } from '/_lib/api.js';
//   const { user, workspace } = await ensureAuth();
//   const { products } = await api.get('/api/inventory/products');
// ============================================================================

async function request(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: {
      'Accept': 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });

  // 204 No Content
  if (res.status === 204) return null;

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = new Error(body?.error || `http_${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  get:    (path)         => request(path, { method: 'GET' }),
  post:   (path, body)   => request(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  (path, body)   => request(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  put:    (path, body)   => request(path, { method: 'PUT',    body: JSON.stringify(body) }),
  del:    (path)         => request(path, { method: 'DELETE' }),
};

/**
 * Fetch the current session. If unauthenticated, redirect to sign-in and
 * throw so the caller doesn't continue rendering with `undefined`.
 *
 * Returns { user, workspace }.
 */
export async function ensureAuth() {
  try {
    return await api.get('/api/auth/me');
  } catch (err) {
    if (err.status === 401) {
      // Preserve where they were trying to go so we can bounce them back after login.
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/index.html?next=${returnTo}`);
    }
    throw err;
  }
}

// ============================================================================
// Money helpers. Backend stores paise (₹1 = 100 paise). UI works in rupees.
// ============================================================================
export const rupeesToPaise = (rupees) => Math.round(Number(rupees) * 100);
export const paiseToRupees = (paise)  => Number(paise) / 100;

/**
 * formatINR(842500) → "₹8,42,500"   (Indian numbering, no decimals if whole)
 * formatINR(842550) → "₹8,42,550"
 * formatINR(0)      → "₹0"
 * Accepts amount in PAISE. Pass options.rupees=true if you already have rupees.
 */
export function formatINR(paise, opts = {}) {
  const rupees = opts.rupees ? Number(paise) : paiseToRupees(paise);
  if (!Number.isFinite(rupees)) return '—';
  const isWhole = Math.abs(rupees % 1) < 0.005;
  return '₹' + rupees.toLocaleString('en-IN', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Time-aware greeting matching the pattern used on the dashboard.
 */
export function greetingFor(name) {
  const first = (name || '').split(' ')[0] || 'there';
  const h = new Date().getHours();
  if (h < 5)  return `Working late, ${first}`;
  if (h < 12) return `Good morning, ${first}`;
  if (h < 17) return `Good afternoon, ${first}`;
  if (h < 22) return `Good evening, ${first}`;
  return `Working late, ${first}`;
}

// ============================================================================
// Prefetch-on-hover. Warms the browser cache for a detail page when the user
// hovers/focuses a list row, so the click feels instant. One delegated listener
// on `document` (call once per page — survives list re-renders via delegation).
// `resolveHref(el)` maps a hovered [data-id]/[data-href] element to a URL (or
// null to skip). Each destination is prefetched at most once. Silently degrades
// where <link rel="prefetch"> is unsupported.
// ============================================================================
export function installPrefetch(resolveHref) {
  const seen = new Set();
  const arm = (e) => {
    const el = e.target?.closest?.('[data-id],[data-href]');
    if (!el) return;
    let href = null;
    try { href = resolveHref(el); } catch { href = null; }
    if (!href || seen.has(href)) return;
    seen.add(href);
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    document.head.appendChild(link);
  };
  document.addEventListener('pointerover', arm, { passive: true });
  document.addEventListener('focusin', arm);
}
