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

// The full registry. 28 keys, grouped. Value = human-readable description
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
  'substitutions.manage':   'Create, execute, and revert substitutions',
  // Money-adjacent (Sub-slice 2.3) — staff (warehouse) NEVER holds these.
  'substitutions.financial':'Substitutions that charge or credit the customer',
  'damage.resolve_financial':'Set damage liability, resolution, and deposit action',
  'damage.approve':         'Approve high-value or disputed damage resolutions',
  // Money
  'payments.record':        'Record payments',
  'payments.refund':        'Issue refunds',
  'deposits.retain':        'Retain part or all of a security deposit',
  'deposits.transfer_custody':'Transfer physical custody of a cash/cheque deposit',
  'inspections.perform':    'Perform return inspections and record outcomes',
  'invoices.manage':        'Create and void invoices',
  // Inventory
  'inventory.view':         'View products and stock',
  'inventory.manage':       'Add, edit, remove products, stock, and downtime',
  'inventory.pricing':      'Set product pricing',
  'inventory.costs':        'View and set purchase costs and ROI',
  'inventory.retire':       'Retire assets from the operational fleet',
  // People
  'people.view':            'View customers',
  'people.manage':          'Create and edit customers',
  'people.view_sensitive':  'View KYC documents (Aadhaar, PAN)',
  'people.review_kyc':      'Review and verify KYC documents',
  // Insight
  'reports.view':           'View performance reports',
  'reports.export':         'Generate exports',
  'audit.view':             'View activity logs',
  // Notifications (Slice 10)
  'notifications.review':   'Review and approve pending notifications',
  'settings.edit_notifications':'Configure notification policy',
  // Workspace
  'settings.manage':        'Manage workspace settings',
  'team.manage':            'Invite and manage team members',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

// Grouping for the Team editor UI (label → keys). Order matters for rendering.
export const PERMISSION_GROUPS: { label: string; keys: PermissionKey[] }[] = [
  { label: 'Orders',    keys: ['orders.view','orders.create','orders.edit','orders.cancel','orders.revert_status','orders.override_period','orders.override_price','orders.apply_discount'] },
  { label: 'Operations', keys: ['dispatch.execute','returns.execute','damage.record','substitutions.manage','substitutions.financial','damage.resolve_financial','damage.approve','inspections.perform'] },
  { label: 'Money',     keys: ['payments.record','payments.refund','deposits.retain','deposits.transfer_custody','invoices.manage'] },
  { label: 'Inventory', keys: ['inventory.view','inventory.manage','inventory.pricing','inventory.costs','inventory.retire'] },
  { label: 'People',    keys: ['people.view','people.manage','people.view_sensitive','people.review_kyc'] },
  { label: 'Insight',   keys: ['reports.view','reports.export','audit.view'] },
  { label: 'Notifications', keys: ['notifications.review','settings.edit_notifications'] },
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
    'substitutions.manage', 'substitutions.financial', 'damage.resolve_financial',
    'inspections.perform',
    'payments.record', 'payments.refund', 'deposits.retain', 'deposits.transfer_custody', 'invoices.manage',
    'inventory.view', 'inventory.manage', 'inventory.pricing', 'inventory.retire',
    'people.view', 'people.manage', 'people.view_sensitive', 'people.review_kyc',
    'reports.view', 'reports.export',
    // Slice 10: manager reviews the notification queue + edits notification policy
    // (a narrower grant than settings.manage, which stays owner-only).
    'notifications.review', 'settings.edit_notifications',
    // NOT: inventory.costs, audit.view, settings.manage, team.manage
  ],
  staff: [
    'orders.view', 'orders.create', 'orders.edit',
    'dispatch.execute', 'returns.execute', 'damage.record',
    // Warehouse (Irfan) performs return inspections — but NOT custody transfer
    // (cash/cheque custody stays owner/manager/accounts per deposit_policy).
    'inspections.perform',
    // Operational swaps only — staff (warehouse) can create/execute substitutions
    // but NOT the financial ones, and NEVER touches damage financial resolution.
    'substitutions.manage',
    'inventory.view',
    'people.view',
    // NOT: cancel, revert, overrides, discounts, all money, costs,
    //      substitutions.financial, damage.resolve_financial, damage.approve(owner),
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
