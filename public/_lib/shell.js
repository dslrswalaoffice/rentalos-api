// ============================================================================
// /_lib/shell.js — Canonical RentalOS app shell (icon rail + top-bar).
// ----------------------------------------------------------------------------
// Foundation Slice F1. Single source of truth for the left navigation and the
// top-bar, so the 8-module nav + terminology can never drift across pages again
// (before this, every page inlined its own rail — some said "Customers", some
// "People"; Finance + Communications were missing; markup varied).
//
// NOT a new pattern: every page already imports ES modules from /_lib (api.js).
// This is that same pattern applied to markup. Usage on any operational page:
//
//     import { renderShell } from '/_lib/shell.js';
//     renderShell('people');   // pass the active module key
//
// It injects <aside class="rail"> as the first child of .shell and
// <header class="topbar"> as the first child of <main>, reusing the .rail /
// .topbar / .iconbtn / .tsearch / .avatar-sm classes each page already defines.
// CSS stays page-local for now (centralising it is a bounded follow-up step);
// this step removes the MARKUP duplication, which is where the drift lived.
//
// The avatar (#me-initials) is rendered as a placeholder; each page's existing
// ensureAuth() flow still populates it (unchanged).
// ============================================================================

// 8 modules, new terminology (Constitution §6 / Gate 9). `href: null` marks a
// module whose page doesn't exist yet — rendered as a disabled Item-12 "coming
// soon" action rather than a dead link. System is pinned to the bottom.
const NAV_TOP = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard.html',
    icon: '<rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/>' },
  { key: 'orders', label: 'Orders', href: '/orders.html',
    icon: '<path d="M10 2.2 17 6v8l-7 3.8L3 14V6z"/><path d="M3 6l7 3.8L17 6"/><path d="M10 9.8V17.8"/>' },
  { key: 'assets', label: 'Assets', href: '/inventory.html',
    icon: '<path d="M10 2.5 17.5 6 10 9.5 2.5 6z"/><path d="M2.5 10 10 13.5 17.5 10"/><path d="M2.5 14 10 17.5 17.5 14"/>' },
  { key: 'people', label: 'People', href: '/people-list.html',
    icon: '<circle cx="7" cy="6.5" r="2.6"/><path d="M2.4 16c0-2.9 2-4.5 4.6-4.5S11.6 13.1 11.6 16"/><path d="M12.6 4.2a2.5 2.5 0 0 1 0 4.8M14 11.6c2 .4 3.5 1.9 3.5 4.4"/>' },
  { key: 'finance', label: 'Finance', href: null,
    icon: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M2.5 8.5h15"/><circle cx="13.5" cy="12" r="1.2"/>' },
  { key: 'insights', label: 'Insights', href: '/analytics.html',
    icon: '<path d="M3 17V3"/><path d="M3 17h14"/><rect x="6" y="10" width="2.6" height="4"/><rect x="10.5" y="6.5" width="2.6" height="7.5"/>' },
  { key: 'comms', label: 'Communications', href: null,
    icon: '<path d="M3 14.5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6.5L3 16.5z"/>' },
];
const NAV_SYSTEM = { key: 'system', label: 'System', href: '/settings.html',
  icon: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M2.5 10h2.2M15.3 10h2.2M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>' };

const SVG = (paths) =>
  `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

function navItem(m, activeKey) {
  const icon = SVG(m.icon);
  if (!m.href) {
    // Coming-soon module: disabled, visible, explained (Item 12 blocked action).
    return `<div class="ri" title="${m.label} — coming soon" style="opacity:.4;cursor:not-allowed">${icon}</div>`;
  }
  const active = m.key === activeKey ? ' class="active"' : '';
  return `<a href="${m.href}"${active} title="${m.label}">${icon}</a>`;
}

function railHTML(activeKey) {
  const top = NAV_TOP.map((m) => navItem(m, activeKey)).join('');
  return `<aside class="rail">
    <div class="logo">R</div>
    ${top}
    <div style="flex:1"></div>
    ${navItem(NAV_SYSTEM, activeKey)}
  </aside>`;
}

function topbarHTML() {
  return `<header class="topbar">
    <button class="iconbtn" aria-label="Menu"><svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6h14M3 10h14M3 14h14"/></svg></button>
    <div class="tsearch">
      <svg width="16" height="16" fill="none" stroke="#9ca3af" stroke-width="1.7" stroke-linecap="round"><circle cx="7.5" cy="7.5" r="5"/><path d="M11.5 11.5 15 15"/></svg>
      <span>Search anything</span>
      <span style="margin-left:auto;font:600 10px var(--mono,'JetBrains Mono',monospace);color:#b6b3ad;border:1px solid #e4e0d9;border-radius:5px;padding:2px 6px">⌘K</span>
    </div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:14px">
      <button class="iconbtn" aria-label="Notifications"><svg width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5a5 5 0 0 0-5 5c0 4-1.5 5.5-1.5 5.5h13S15 11.5 15 7.5a5 5 0 0 0-5-5z"/><path d="M8.5 16a1.7 1.7 0 0 0 3 0"/></svg></button>
      <span class="avatar-sm" id="me-initials">··</span>
    </div>
  </header>`;
}

/**
 * Inject the canonical rail + top-bar into the current page.
 * @param {string} activeKey one of: dashboard|orders|assets|people|finance|insights|comms|system
 */
export function renderShell(activeKey) {
  const shell = document.querySelector('.shell');
  const main = shell && shell.querySelector('main');
  if (!shell || !main) {
    console.warn('[shell] expected .shell > main; shell not injected');
    return;
  }
  main.insertAdjacentHTML('afterbegin', topbarHTML());
  shell.insertAdjacentHTML('afterbegin', railHTML(activeKey));
}
