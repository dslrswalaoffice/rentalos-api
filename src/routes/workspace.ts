import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/workspace.ts  (Sub-turn 4a)
// ----------------------------------------------------------------------------
// Workspace settings management, moved out of raw SQL into a product surface.
//
//   GET   /api/workspace           full state: workspace + settings + me + users
//   PATCH /api/workspace/settings  role-gated, whitelisted settings/metadata edit
//
// Role rules (workspace_role enum has no 'admin' — "admin+" maps to manager+):
//   * settings.features.*  → owner only
//   * workspace.* / other settings → owner or manager
//   * everyone else → 403 insufficient_role
//
// Structured address (line1/2, city, state, postal_code) lives in real columns;
// on save we recompose the legacy business_address so the invoice snapshot (which
// reads business_address) stays coherent.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const workspace = new Hono<Env>();
workspace.use('*', sessionMiddleware, requireAuth);

const KNOWN_FLAGS = new Set([
  'qr_scanning', 'otp_handover', 'customer_tiers', 'vip_consolidated_billing',
  'trust_score', 'investor_module', 'cashfree_gateway', 'wati_notifications',
  'gst_split_cgst_sgst_igst', 'damage_module', 'auto_close_when_all_items_terminal',
  'contract_signatures',
]);
const METADATA_ROLES = new Set(['owner', 'manager']);

const DEFAULT_TERMS =
  'Payment due within 15 days of invoice date. Late payment attracts interest at 24% p.a.';

// ----------------------------------------------------------------------------
// Types + helpers
// ----------------------------------------------------------------------------
type WorkspaceRow = {
  id: string; slug: string; legal_name: string | null; gstin: string | null;
  pan: string | null; place_of_supply: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null;
  state: string | null; postal_code: string | null;
  business_phone: string | null; business_email: string | null;
  business_address: string | null; settings: unknown; created_at: string;
};

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// Normalize the JSONB into the exact 5-key shape the frontend expects.
function normalizeSettings(raw: unknown) {
  const s = (raw ?? {}) as Record<string, any>;
  const b = s.billing ?? {}, t = s.tax ?? {}, inv = s.invoice ?? {}, bd = s.bank_details ?? {}, f = s.features ?? {};
  const contract = s.contract ?? {};
  const features: Record<string, boolean> = {};
  for (const k of KNOWN_FLAGS) features[k] = f[k] === true;
  return {
    billing: {
      rounding_rule: b.rounding_rule ?? '24_hour_windows',
      grace_period_hours: typeof b.grace_period_hours === 'number' ? b.grace_period_hours : 0,
      minimum_days: typeof b.minimum_days === 'number' ? b.minimum_days : 1,
    },
    tax: {
      default_gst_percent: typeof t.default_gst_percent === 'number' ? t.default_gst_percent : 18,
      charge_gst_by_default: t.charge_gst_by_default === true,
    },
    invoice: {
      number_format: inv.number_format ?? 'YYYY-MM-DD-{order}-{seq}-R{rev}',
      terms: inv.terms ?? DEFAULT_TERMS,
      default_due_days: typeof inv.default_due_days === 'number' ? inv.default_due_days : 15,
    },
    bank_details: {
      account_name: bd.account_name ?? null,
      bank_name: bd.bank_name ?? null,
      account_number: bd.account_number ?? null,
      ifsc: bd.ifsc ?? null,
      branch: bd.branch ?? null,
      upi_id: bd.upi_id ?? null,
    },
    contract: {
      template_text: typeof contract.template_text === 'string' ? contract.template_text : '',
      template_version: contract.template_version ?? 'v1',
    },
    // Reminders are passed through raw (deeply nested per-channel config). The
    // settings UI reads/writes this object directly.
    reminders: s.reminders ?? {},
    features,
  };
}

async function loadWorkspaceRow(workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = await query<WorkspaceRow>(sql`
    SELECT id, slug, legal_name, gstin, pan, place_of_supply,
           address_line1, address_line2, city, state, postal_code,
           business_phone, business_email, business_address, settings, created_at
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0] ?? null;
}

async function buildState(session: NonNullable<SessionVar>) {
  const ws = await loadWorkspaceRow(session.workspace.id);
  if (!ws) return null;

  const meRows = await query<{ display_name: string; email: string }>(sql`
    SELECT display_name, email FROM users WHERE id = ${session.user.id}::uuid LIMIT 1
  `);
  const users = await query<{
    id: string; display_name: string; email: string; role: string; status: string; created_at: string;
  }>(sql`
    SELECT u.id, u.display_name, u.email, m.role::text AS role, m.status::text AS status, u.created_at
    FROM users u
    JOIN workspace_memberships m ON m.user_id = u.id
    WHERE m.workspace_id = ${session.workspace.id}::uuid
      AND u.deleted_at IS NULL
    ORDER BY m.joined_at ASC
  `);

  return {
    workspace: {
      id: ws.id,
      slug: ws.slug,
      legal_name: ws.legal_name,
      gstin: ws.gstin,
      pan: ws.pan,
      place_of_supply: ws.place_of_supply,
      address_line1: ws.address_line1,
      address_line2: ws.address_line2,
      city: ws.city,
      state: ws.state,
      postal_code: ws.postal_code,
      phone: ws.business_phone,
      email: ws.business_email,
      created_at: ws.created_at,
    },
    settings: normalizeSettings(ws.settings),
    current_user: {
      id: session.user.id,
      display_name: meRows[0]?.display_name ?? session.user.displayName,
      email: meRows[0]?.email ?? null,
      role: session.user.role,
    },
    users: users.map((u) => ({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      role: u.role,
      is_active: u.status === 'active',
      created_at: u.created_at,
    })),
  };
}

// ============================================================================
// GET /api/workspace
// ============================================================================
workspace.get('/', async (c) => {
  const session = c.get('session')!;
  const state = await buildState(session);
  if (!state) return c.json({ error: 'not_found' }, 404);
  // Workspace config/settings change rarely; let the browser cache it per
  // navigation. `private` is mandatory — this is workspace-scoped (multi-tenant)
  // data that must never land in a shared cache. Settings/feature mutations
  // update the client from the PATCH response (never re-GET), so there's no
  // read-after-write staleness.
  c.header('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  return c.json(state);
});

// ============================================================================
// PATCH /api/workspace/settings
// ============================================================================
const nullableStr = (max: number) => z.string().max(max).nullable().optional();

// Reminder template sub-schemas (Sub-turn 6f).
const reminderChannelSchema = z.array(z.enum(['whatsapp', 'email'])).optional();
const reminderWhatsappSchema = z.object({
  template_name:  z.string().max(200).optional(),
  variable_order: z.array(z.string().max(50)).optional(),
}).optional();
const reminderEmailSchema = z.object({
  subject: z.string().max(500).optional(),
  body:    z.string().max(20000).optional(),
}).optional();
const reminderUpcomingSchema = z.object({
  enabled:         z.boolean().optional(),
  days_before_due: z.number().int().min(0).max(30).optional(),
  channels:        reminderChannelSchema,
  whatsapp:        reminderWhatsappSchema,
  email:           reminderEmailSchema,
});
const reminderOverdueSchema = z.object({
  enabled:           z.boolean().optional(),
  days_after_due:    z.number().int().min(0).max(90).optional(),
  repeat_every_days: z.number().int().min(1).max(90).optional(),
  channels:          reminderChannelSchema,
  whatsapp:          reminderWhatsappSchema,
  email:             reminderEmailSchema,
});

const patchSchema = z.object({
  workspace: z.object({
    legal_name:      z.string().max(200).optional(),
    gstin:           nullableStr(20),
    pan:             nullableStr(20),
    address_line1:   nullableStr(200),
    address_line2:   nullableStr(200),
    city:            nullableStr(100),
    state:           nullableStr(100),
    postal_code:     nullableStr(20),
    phone:           nullableStr(30),
    email:           z.string().email().max(200).nullable().optional(),
    place_of_supply: nullableStr(100),
  }).optional(),
  settings: z.object({
    billing: z.object({
      rounding_rule:      z.enum(['24_hour_windows', 'calendar_day']).optional(),
      grace_period_hours: z.number().int().min(0).max(72).optional(),
      minimum_days:       z.number().int().min(1).max(30).optional(),
    }).optional(),
    tax: z.object({
      default_gst_percent:   z.number().min(0).max(100).optional(),
      charge_gst_by_default: z.boolean().optional(),
    }).optional(),
    invoice: z.object({
      number_format:    z.string().max(200).optional(),
      terms:            z.string().max(5000).optional(),
      default_due_days: z.number().int().min(0).max(365).optional(),
    }).optional(),
    bank_details: z.object({
      account_name:   nullableStr(200),
      bank_name:      nullableStr(200),
      account_number: nullableStr(50),
      ifsc:           nullableStr(20),
      branch:         nullableStr(200),
      upi_id:         nullableStr(100),
    }).optional(),
    contract: z.object({
      template_text:    z.string().max(20000).optional(),
      template_version: z.string().max(50).optional(),
    }).optional(),
    reminders: z.object({
      sender_name: z.string().max(200).optional(),
      templates: z.object({
        invoice_upcoming: reminderUpcomingSchema.optional(),
        invoice_overdue: reminderOverdueSchema.optional(),
      }).optional(),
    }).optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    // Sub-slice 2.1 — order policy objects (whole-object replace on save). Edited
    // from settings-order-policies.html; gated by settings.manage + admin roles.
    extension_policy:    z.record(z.string(), z.any()).optional(),
    cancellation_policy: z.record(z.string(), z.any()).optional(),
    approval_routing:    z.record(z.string(), z.any()).optional(),
    notification_policy: z.record(z.string(), z.any()).optional(),
    standby_policy:      z.record(z.string(), z.any()).optional(),
    quote_policy:        z.record(z.string(), z.any()).optional(),
  }).optional(),
});

// Sub-slice 2.1/2.2 — order policy sub-objects the settings page may write.
const ORDER_POLICY_KEYS = ['extension_policy', 'cancellation_policy', 'approval_routing', 'notification_policy', 'standby_policy', 'quote_policy'] as const;

workspace.patch('/settings', requirePermission('settings.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const role = session.user.role;

  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const wf = input.workspace ?? {};
  const sf = input.settings ?? {};
  const featureKeys = sf.features ? Object.keys(sf.features) : [];
  const hasFeatures = featureKeys.length > 0;
  const hasOrderPolicy = ORDER_POLICY_KEYS.some((k) => sf[k] !== undefined);
  const hasMetadata =
    Object.keys(wf).length > 0 ||
    !!(sf.billing || sf.tax || sf.invoice || sf.bank_details || sf.contract || sf.reminders) ||
    hasOrderPolicy;

  // Role gates.
  if (hasFeatures && role !== 'owner') {
    return c.json({ error: 'insufficient_role', reason: 'feature_flags_owner_only' }, 403);
  }
  if (hasMetadata && !METADATA_ROLES.has(role)) {
    return c.json({ error: 'insufficient_role', reason: 'metadata_admin_only' }, 403);
  }
  if (!hasFeatures && !hasMetadata) {
    return c.json({ error: 'nothing_to_update' }, 400);
  }

  // Whitelist feature keys — never let an unknown flag into the JSONB.
  for (const k of featureKeys) {
    if (!KNOWN_FLAGS.has(k)) return c.json({ error: 'unknown_feature_flag', flag: k }, 400);
  }

  const wsRow = await loadWorkspaceRow(session.workspace.id);
  if (!wsRow) return c.json({ error: 'not_found' }, 404);

  const changedPaths: string[] = [];

  // Build the next settings JSONB from a clone of the current one (preserves any
  // extra keys such as the legacy `deposit` object).
  const next = JSON.parse(JSON.stringify(wsRow.settings ?? {})) as Record<string, any>;
  for (const sub of ['billing', 'tax', 'invoice', 'bank_details', 'contract', 'reminders'] as const) {
    if (sf[sub]) {
      next[sub] = { ...(next[sub] ?? {}) };
      for (const [k, v] of Object.entries(sf[sub] as Record<string, unknown>)) {
        next[sub][k] = v;
        changedPaths.push(`settings.${sub}.${k}`);
      }
    }
  }
  if (sf.features) {
    next.features = { ...(next.features ?? {}) };
    for (const [k, v] of Object.entries(sf.features)) {
      next.features[k] = v;
      changedPaths.push(`settings.features.${k}`);
    }
  }
  // Order policy objects — shallow-merge the top level (the settings page sends
  // the complete policy object, so nested groups like tiers replace wholesale).
  for (const key of ORDER_POLICY_KEYS) {
    if (sf[key] !== undefined) {
      next[key] = { ...(next[key] ?? {}), ...(sf[key] as Record<string, unknown>) };
      changedPaths.push(`settings.${key}`);
    }
  }

  // Workspace columns (COALESCE keeps unspecified fields; "" clears, undefined no-ops).
  const updated = await query<WorkspaceRow>(sql`
    UPDATE workspaces SET
      legal_name      = COALESCE(${wf.legal_name      ?? null}::text, legal_name),
      gstin           = COALESCE(${wf.gstin           ?? null}::text, gstin),
      pan             = COALESCE(${wf.pan             ?? null}::text, pan),
      place_of_supply = COALESCE(${wf.place_of_supply ?? null}::text, place_of_supply),
      address_line1   = COALESCE(${wf.address_line1   ?? null}::text, address_line1),
      address_line2   = COALESCE(${wf.address_line2   ?? null}::text, address_line2),
      city            = COALESCE(${wf.city            ?? null}::text, city),
      state           = COALESCE(${wf.state           ?? null}::text, state),
      postal_code     = COALESCE(${wf.postal_code     ?? null}::text, postal_code),
      business_phone  = COALESCE(${wf.phone           ?? null}::text, business_phone),
      business_email  = COALESCE(${wf.email           ?? null}::text, business_email),
      settings        = ${JSON.stringify(next)}::jsonb
    WHERE id = ${session.workspace.id}::uuid
    RETURNING id, slug, legal_name, gstin, pan, place_of_supply,
              address_line1, address_line2, city, state, postal_code,
              business_phone, business_email, business_address, settings, created_at
  `);
  for (const k of Object.keys(wf)) changedPaths.push(`workspace.${k}`);

  // Keep business_address (the invoice snapshot source) in sync with the parts.
  const addrTouched = ['address_line1', 'address_line2', 'city', 'state', 'postal_code'].some((k) => k in wf);
  if (addrTouched && updated[0]) {
    const u = updated[0];
    const cityLine = [u.city, u.state, u.postal_code].filter(Boolean).join(', ');
    const composed = [u.address_line1, u.address_line2, cityLine].filter(Boolean).join('\n');
    await sql`
      UPDATE workspaces SET business_address = ${composed || null}::text
      WHERE id = ${session.workspace.id}::uuid
    `;
  }

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'workspace.settings.updated',
    targetType: 'workspace',
    targetId: session.workspace.id,
    payload: { changed_paths: changedPaths, role },
    ipAddress, userAgent,
  });

  const state = await buildState(session);
  return c.json(state);
});
