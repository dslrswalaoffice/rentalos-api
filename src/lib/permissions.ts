// ============================================================================
// src/lib/permissions.ts  (Sub-turn 12a)
// ----------------------------------------------------------------------------
// Roles + granular per-member permissions (Booqable's model): the ROLE is a
// preset that seeds a permission set at invite time; each permission is then
// individually toggleable per member. The PERMISSION is the truth, not the role.
//
// Locked decisions:
//   - Roles collapse to owner | manager | staff. client/investor removed.
//   - Owner always has every permission — ENFORCED IN CODE, never stored as
//     toggles. An owner's permissions can't be reduced by anyone.
//   - Permissions live in a JSONB column on workspace_memberships. The session
//     middleware already loads that row, so can() costs ZERO extra queries.
//   - The key registry lives HERE, in code — adding a permission is a code
//     change + a preset default, not a migration.
//   - Deny by default: an unknown or absent key = denied.
// ============================================================================

import { createMiddleware } from 'hono/factory';

// The full registry. 24 keys, grouped. Value = human-readable description
// (rendered on the Team permission editor). Adding a permission = add a key
// here + include it in the relevant preset(s) below.
export const PERMISSIONS = {
  // Orders
  'orders.view':            'View orders',
  'orders.create':          'Create orders',
  'orders.edit':            'Edit order details and line items',
  'orders.cancel':          'Cancel orders',
  'orders.revert_status':   'Revert an order to a previous status',
  'orders.override_period': 'Override rental period restrictions',
  'orders.override_price':  'Manually override calculated prices',
  'orders.apply_discount':  'Apply discounts and coupons',
  // Operations
  'dispatch.execute':       'Dispatch gear and hand over',
  'returns.execute':        'Check in returns',
  'damage.record':          'Record damage and open repair tickets',
  // Money
  'payments.record':        'Record payments',
  'payments.refund':        'Issue refunds',
  'deposits.retain':        'Retain part or all of a security deposit',
  'invoices.manage':        'Create and void invoices',
  // Inventory
  'inventory.view':         'View products and stock',
  'inventory.manage':       'Add, edit, remove products, stock, and downtime',
  'inventory.pricing':      'Set product pricing',
  'inventory.costs':        'View and set purchase costs and ROI',
  // People
  'people.view':            'View customers',
  'people.manage':          'Create and edit customers',
  'people.view_sensitive':  'View KYC documents (Aadhaar, PAN)',
  // Insight
  'reports.view':           'View performance reports',
  'reports.export':         'Generate exports',
  'audit.view':             'View activity logs',
  // Workspace
  'settings.manage':        'Manage workspace settings',
  'team.manage':            'Invite and manage team members',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

// Grouping for the Team editor UI (label → keys). Order matters for rendering.
export const PERMISSION_GROUPS: { label: string; keys: PermissionKey[] }[] = [
  { label: 'Orders',    keys: ['orders.view','orders.create','orders.edit','orders.cancel','orders.revert_status','orders.override_period','orders.override_price','orders.apply_discount'] },
  { label: 'Operations', keys: ['dispatch.execute','returns.execute','damage.record'] },
  { label: 'Money',     keys: ['payments.record','payments.refund','deposits.retain','invoices.manage'] },
  { label: 'Inventory', keys: ['inventory.view','inventory.manage','inventory.pricing','inventory.costs'] },
  { label: 'People',    keys: ['people.view','people.manage','people.view_sensitive'] },
  { label: 'Insight',   keys: ['reports.view','reports.export','audit.view'] },
  { label: 'Workspace', keys: ['settings.manage','team.manage'] },
];

export type WorkspaceRole = 'owner' | 'manager' | 'staff';

// Presets. owner is a sentinel — NEVER stored (owner permissions are
// code-enforced). manager/staff are concrete key lists seeded at invite time
// and freely editable afterward.
export const PRESETS: { owner: '*'; manager: PermissionKey[]; staff: PermissionKey[] } = {
  owner: '*',
  manager: [
    'orders.view', 'orders.create', 'orders.edit', 'orders.cancel',
    'orders.revert_status', 'orders.override_period', 'orders.override_price',
    'orders.apply_discount',
    'dispatch.execute', 'returns.execute', 'damage.record',
    'payments.record', 'payments.refund', 'deposits.retain', 'invoices.manage',
    'inventory.view', 'inventory.manage', 'inventory.pricing',
    'people.view', 'people.manage', 'people.view_sensitive',
    'reports.view', 'reports.export',
    // NOT: inventory.costs, audit.view, settings.manage, team.manage
  ],
  staff: [
    'orders.view', 'orders.create', 'orders.edit',
    'dispatch.execute', 'returns.execute', 'damage.record',
    'inventory.view',
    'people.view',
    // NOT: cancel, revert, overrides, discounts, all money, costs,
    //      sensitive KYC, reports, settings, team
  ],
};

// The permissions JSONB to store for a member seeded from a role. Owner → {}
// (code-enforced). manager/staff → every preset key set true.
export function presetPermissions(role: WorkspaceRole): Record<string, boolean> {
  if (role === 'owner') return {};
  const out: Record<string, boolean> = {};
  for (const key of PRESETS[role]) out[key] = true;
  return out;
}

// A minimal session shape can() accepts — decoupled from the exact SessionVar
// each route file redeclares. permissions is optional so a session typed without
// it (the local SessionVar duplicates) still type-checks; at runtime the object
// always carries it (getSession selects m.permissions).
type CanSession =
  | { user: { role: string }; permissions?: Record<string, boolean> | null }
  | null
  | undefined;

// THE check. Owner = everything, always. Otherwise deny by default: the key
// must be explicitly true in the member's stored permissions.
export function can(session: CanSession, permission: PermissionKey): boolean {
  if (!session) return false;
  if (session.user.role === 'owner') return true;
  return session.permissions?.[permission] === true;
}

// Route middleware: 403 unless the caller holds ALL listed permissions. Chain
// AFTER sessionMiddleware + requireAuth. One key is the common case.
export function requirePermission(...keys: PermissionKey[]) {
  return createMiddleware(async (c, next) => {
    const session = (c as unknown as {
      get: (k: 'session') => CanSession;
    }).get('session');
    if (!session) return c.json({ error: 'not_authenticated' }, 401);
    if (keys.every((k) => can(session, k))) {
      await next();
      return;
    }
    return c.json({ error: 'forbidden', required_permission: keys }, 403);
  });
}
