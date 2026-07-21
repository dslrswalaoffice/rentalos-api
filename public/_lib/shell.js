// IMPORTANT: When shell.js contents change materially, bump the ?v=N query in ALL consumer imports.
// Current consumers (as of this commit): people-list.html, person-360.html, orders.html, new-order.html.
// ============================================================================
// /_lib/shell.js — Canonical RentalOS app shell (icon rail + optional top-bar).
// ----------------------------------------------------------------------------
// Foundation Slice. Single source of truth for the left navigation, so the
// 8-module nav + terminology can never drift across pages again (before this,
// every page inlined its own rail — some said "Customers", some "People";
// Finance + Communications were missing; markup + active colours varied).
//
// NOT a new pattern: every page already imports ES modules from /_lib (api.js).
// This is that same pattern applied to markup. Usage on any operational page:
//
//     import { renderShell } from '/_lib/shell.js';
//     renderShell('orders');                    // rail + canonical top-bar
//     renderShell('orders', { topbar: false }); // rail only — keep page's own top-bar
//
// F2a hardening (self-contained):
//   * Mounts flexibly: wrapper = `.shell` OR `.app`; content = its <main>.
//   * Injects its OWN rail CSS (once) so the rail looks identical on every page
//     regardless of that page's legacy sidebar CSS — cascade-authoritative
//     because the <style> is appended after the page's inline styles.
//   * `topbar: false` skips the top-bar entirely (for pages whose top-bar
//     carries page-specific wiring — a functional notification bell, a different
//     avatar id — that this step must not disturb).
//
// The avatar (#me-initials, only when the top-bar is rendered) is a placeholder;
// the page's existing ensureAuth() flow still populates it.
// ============================================================================

// 8 modules, new terminology (Constitution §6 / Gate 9). `href: null` marks a
// module whose page doesn't exist yet — rendered as a disabled Item-12 "coming
// soon" action rather than a dead link. System is pinned to the bottom.
// The user menu (avatar dropdown) reuses the shared data layer — no new dep.
import { api, ensureAuth } from './api.js';

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
    return `<div class="ri soon" title="${m.label} — coming soon">${icon}</div>`;
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
      <div class="shell-user">
        <button class="avatar-sm" id="me-initials" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">··</button>
        <div class="shell-user-menu" id="shell-user-menu" role="menu" hidden>
          <div class="shell-user-head">
            <span class="shell-user-name" id="shell-user-name">…</span>
            <span class="shell-user-role" id="shell-user-role"></span>
          </div>
          <a class="shell-user-item" role="menuitem" href="/settings.html">System settings</a>
          <button class="shell-user-item" role="menuitem" id="shell-signout" type="button">Sign out</button>
        </div>
      </div>
    </div>
  </header>`;
}

// Tiny initials helper for the avatar (name → up to 2 letters).
function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  return p.length ? (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase() : '··';
}

// Wire the top-bar avatar dropdown: toggle on click, close on outside-click/Esc,
// lazy-load name/role on first open (no fetch until the user actually opens it),
// Sign out → POST /api/auth/logout then back to the sign-in page.
function wireUserMenu() {
  const btn = document.getElementById('me-initials');
  const menu = document.getElementById('shell-user-menu');
  if (!btn || !menu) return;
  let loaded = false;
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden && !loaded) {
      loaded = true;
      try {
        const { user } = await ensureAuth();
        const name = (user && (user.display_name || user.email)) || 'Account';
        document.getElementById('shell-user-name').textContent = name;
        document.getElementById('shell-user-role').textContent = (user && user.role) || '';
        if (btn.textContent === '··') btn.textContent = initials(name);
      } catch { /* ensureAuth redirects on auth failure */ }
    }
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.shell-user')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const out = document.getElementById('shell-signout');
  if (out) out.addEventListener('click', async () => {
    try { await api.post('/api/auth/logout', {}); } catch { /* fall through to redirect */ }
    window.location.href = '/index.html';
  });
}

// Canonical rail CSS — Warm-Cream family (60px #faf9f7 rail, indigo-soft active).
// Uses each page's design tokens when present, with literal fallbacks so it
// renders correctly even on pages that don't define them (e.g. orders uses
// --surface-1, not --rail). Injected once; appended after page styles so it is
// cascade-authoritative for .rail.
const RAIL_CSS = `
.rail{width:60px;flex:none;background:var(--rail,#faf9f7);border-right:1px solid var(--line,var(--border,#ece9e3));display:flex;flex-direction:column;align-items:center;padding:14px 0;gap:6px;position:sticky;top:0;height:100vh}
.rail .logo{width:32px;height:32px;border-radius:8px;background:var(--ink,#202058);color:#fff;font:600 16px var(--disp,'Space Grotesk',system-ui,sans-serif);display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.rail a,.rail .ri{width:40px;height:40px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:#9a9690}
.rail a:hover{background:#f0eee9;color:var(--head,#26235a)}
.rail a.active{background:var(--indigo-soft,rgba(79,70,229,.1));color:var(--indigo,#4f46e5)}
.rail .ri.soon{opacity:.4;cursor:not-allowed}
`;

const TOPBAR_CSS = `
.topbar{height:56px;flex:none;border-bottom:1px solid var(--line,var(--border,#ece9e3));display:flex;align-items:center;gap:16px;padding:0 22px}
.topbar .tsearch{flex:1;max-width:520px;height:36px;border:1px solid var(--line,#ece9e3);border-radius:9px;background:var(--field,#faf9f7);display:flex;align-items:center;gap:9px;padding:0 12px;color:var(--muted2,#9ca3af);font-size:13px}
.topbar .iconbtn{width:34px;height:34px;border-radius:8px;border:none;background:transparent;color:var(--muted3,#6b7280);display:flex;align-items:center;justify-content:center;cursor:pointer}
.topbar .avatar-sm{width:28px;height:28px;border-radius:50%;background:#eef0f4;color:var(--ink,#202058);font:600 10px var(--disp,'Space Grotesk',system-ui,sans-serif);display:flex;align-items:center;justify-content:center}
.topbar .shell-user{position:relative}
.topbar .shell-user > .avatar-sm{border:none;cursor:pointer}
.topbar .shell-user-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:190px;background:#fff;border:1px solid var(--line,#ece9e3);border-radius:10px;box-shadow:0 12px 32px rgba(32,32,88,.14);padding:6px;z-index:60}
.topbar .shell-user-menu[hidden]{display:none}
.topbar .shell-user-head{display:flex;flex-direction:column;gap:2px;padding:8px 10px 10px;border-bottom:1px solid var(--line2,#f0ede8);margin-bottom:4px}
.topbar .shell-user-name{font:600 13px var(--body,system-ui,sans-serif);color:var(--head,#26235a)}
.topbar .shell-user-role{font:500 11px var(--body,system-ui,sans-serif);color:var(--muted2,#9ca3af);text-transform:capitalize}
.topbar .shell-user-item{display:block;width:100%;text-align:left;padding:8px 10px;border:none;background:none;border-radius:7px;font:500 13px var(--body,system-ui,sans-serif);color:var(--head,#26235a);cursor:pointer;text-decoration:none}
.topbar .shell-user-item:hover{background:var(--field,#f4f2ee)}
`;

function injectCSSOnce(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Inject the canonical rail (and optionally the top-bar) into the current page.
 * @param {string} activeKey  dashboard|orders|assets|people|finance|insights|comms|system
 * @param {{topbar?: boolean}} [opts]  topbar defaults to true; set false to keep the page's own top-bar
 */
export function renderShell(activeKey, opts = {}) {
  const withTopbar = opts.topbar !== false;
  const wrapper = document.querySelector('.shell, .app');
  const main = wrapper && wrapper.querySelector('main');
  if (!wrapper || !main) {
    console.warn('[shell] expected .shell/.app > main; shell not injected');
    return;
  }
  injectCSSOnce('rentalos-shell-rail-css', RAIL_CSS);
  if (withTopbar) {
    injectCSSOnce('rentalos-shell-topbar-css', TOPBAR_CSS);
    main.insertAdjacentHTML('afterbegin', topbarHTML());
    wireUserMenu();
  }
  wrapper.insertAdjacentHTML('afterbegin', railHTML(activeKey));
}
