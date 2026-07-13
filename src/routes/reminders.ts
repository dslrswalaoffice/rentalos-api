import { Hono } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import { decryptJson } from '../lib/crypto.js';
import { findAdapter } from '../lib/adapters/registry.js';
import type { WhatsAppAdapter, EmailAdapter } from '../lib/adapters/types.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/reminders.ts  (Sub-turn 6f) — multi-channel invoice reminders
// ----------------------------------------------------------------------------
//   POST /api/reminders/trigger                     cron (X-Reminder-Secret auth)
//   POST /api/reminders/invoices/:invoiceId/send    manual send (session; ?channel override)
//   GET  /api/reminders/invoices/:invoiceId         reminder log (session)
//
// NOTE on paths: the reminders app is mounted at /api/reminders, so the invoice-
// scoped endpoints live under it (…/reminders/invoices/:id) rather than under a
// separate /api/invoices mount (which doesn't exist — invoices are served at
// /api/order-invoices). Functionally identical to the spec's paths.
//
// Channel priority + templates live in workspace settings.reminders. Fallback:
// skip a channel if the adapter is inactive OR the customer lacks that contact
// method, then try the next channel. 24h cooldown across all channels (cron
// only; manual bypasses it). Every attempt is logged in invoice_reminders with
// the channel actually used.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const reminders = new Hono<Env>();

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
type ReminderType = 'invoice_upcoming' | 'invoice_overdue' | 'manual';
type Channel = 'whatsapp' | 'email';

type EligibleRow = {
  invoice_id: string;
  invoice_number: string;
  total_paise: number;
  order_id: string;
  status: string;
  due_date: string | null;
  order_number: number;
  rental_start: string | null;
  rental_end: string | null;
  customer_id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
};

type LoadedAdapter<T> = { provider: string; adapter: T; credentials: Record<string, string>; config: Record<string, unknown> };

// ----------------------------------------------------------------------------
// Adapter loading (decrypts credentials from the active workspace_integration)
// ----------------------------------------------------------------------------
function decodeCreds(b64: string | null): Record<string, string> {
  if (!b64) return {};
  try {
    return (decryptJson(Buffer.from(b64, 'base64')) as Record<string, string>) ?? {};
  } catch (err) {
    console.error('[reminders] credential decrypt failed', err);
    return {};
  }
}

async function loadActiveAdapter<T>(workspaceId: string, category: Channel): Promise<LoadedAdapter<T> | null> {
  const rows = await query<{ provider: string; credentials_b64: string | null; config: Record<string, unknown> }>(sql`
    SELECT provider, encode(credentials_encrypted, 'base64') AS credentials_b64, config
    FROM workspace_integrations
    WHERE workspace_id = ${workspaceId}::uuid AND category = ${category}::text AND is_active = true
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  const adapter = findAdapter(category, row.provider) as T | null;
  if (!adapter) return null;
  return { provider: row.provider, adapter, credentials: decodeCreds(row.credentials_b64), config: row.config ?? {} };
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------
function inr(paise: number | null | undefined): string {
  return '₹' + (Number(paise ?? 0) / 100).toLocaleString('en-IN');
}
function fmtDate(d: string | null): string {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}
function daysOverdue(dueDate: string | null): number {
  if (!dueDate) return 0;
  const diff = Date.now() - new Date(dueDate).getTime();
  return diff > 0 ? Math.floor(diff / 86400000) : 0;
}
function substitute(text: string, ctx: Record<string, string>): string {
  return String(text || '').replace(/\{(\w+)\}/g, (_, k: string) => (k in ctx ? ctx[k]! : `{${k}}`));
}

function buildContext(row: EligibleRow, ws: WorkspaceRow): Record<string, string> {
  return {
    customer_name: row.display_name || 'Customer',
    invoice_number: row.invoice_number,
    total_amount: inr(row.total_paise),
    due_date: fmtDate(row.due_date),
    days_overdue: String(daysOverdue(row.due_date)),
    order_number: String(row.order_number),
    rental_start: fmtDate(row.rental_start),
    rental_end: fmtDate(row.rental_end),
    workspace_name: ws.reminderSenderName || ws.legal_name || 'RentalOS',
    workspace_email: ws.business_email || '',
    workspace_phone: ws.business_phone || '',
  };
}

// ----------------------------------------------------------------------------
// Workspace config
// ----------------------------------------------------------------------------
type WorkspaceRow = {
  id: string;
  legal_name: string | null;
  business_email: string | null;
  business_phone: string | null;
  settings: any;
  reminderSenderName: string | null;
};

function defaultDueDays(ws: WorkspaceRow): number {
  const n = Number(ws.settings?.invoice?.default_due_days);
  return Number.isFinite(n) && n >= 0 ? n : 15;
}

// ----------------------------------------------------------------------------
// Eligibility (cron)
// ----------------------------------------------------------------------------
async function findUpcoming(ws: WorkspaceRow, daysBefore: number): Promise<EligibleRow[]> {
  const dd = defaultDueDays(ws);
  return query<EligibleRow>(sql`
    SELECT i.id AS invoice_id, i.invoice_number, i.total_paise, i.order_id, i.status::text AS status,
           COALESCE(i.due_date, (i.issued_at + make_interval(days => ${dd}::int))::date) AS due_date,
           o.order_number, o.rental_start, o.rental_end,
           p.id AS customer_id, p.display_name, p.phone, p.email
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    JOIN people p ON p.id = o.customer_person_id
    WHERE i.workspace_id = ${ws.id}::uuid
      AND i.status = 'sent'
      AND COALESCE(i.due_date, (i.issued_at + make_interval(days => ${dd}::int))::date) > now()::date
      AND COALESCE(i.due_date, (i.issued_at + make_interval(days => ${dd}::int))::date) <= (now() + make_interval(days => ${daysBefore}::int))::date
      AND NOT EXISTS (
        SELECT 1 FROM invoice_reminders r
        WHERE r.invoice_id = i.id AND r.reminder_type = 'invoice_upcoming' AND r.status = 'sent'
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_reminders r
        WHERE r.invoice_id = i.id AND r.status = 'sent' AND r.sent_at > now() - interval '24 hours'
      )
  `);
}

async function findOverdue(ws: WorkspaceRow, daysAfter: number, repeatDays: number): Promise<EligibleRow[]> {
  const dd = defaultDueDays(ws);
  return query<EligibleRow>(sql`
    SELECT i.id AS invoice_id, i.invoice_number, i.total_paise, i.order_id, i.status::text AS status,
           COALESCE(i.due_date, (i.issued_at + make_interval(days => ${dd}::int))::date) AS due_date,
           o.order_number, o.rental_start, o.rental_end,
           p.id AS customer_id, p.display_name, p.phone, p.email
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    JOIN people p ON p.id = o.customer_person_id
    WHERE i.workspace_id = ${ws.id}::uuid
      AND i.status = 'sent'
      AND (COALESCE(i.due_date, (i.issued_at + make_interval(days => ${dd}::int))::date) + make_interval(days => ${daysAfter}::int)) <= now()
      AND NOT EXISTS (
        SELECT 1 FROM invoice_reminders r
        WHERE r.invoice_id = i.id AND r.reminder_type = 'invoice_overdue' AND r.status = 'sent'
          AND r.sent_at > now() - make_interval(days => ${repeatDays}::int)
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_reminders r
        WHERE r.invoice_id = i.id AND r.status = 'sent' AND r.sent_at > now() - interval '24 hours'
      )
  `);
}

// ----------------------------------------------------------------------------
// Logging helpers
// ----------------------------------------------------------------------------
async function logSkip(args: {
  ws: WorkspaceRow; row: EligibleRow; reminderType: ReminderType; channel: Channel;
  target: string; reason: string; triggeredBy: string; triggeredByUserId: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO invoice_reminders
      (workspace_id, invoice_id, order_id, reminder_type, channel, target_address,
       status, skip_reason, triggered_by, triggered_by_user_id)
    VALUES (
      ${args.ws.id}::uuid, ${args.row.invoice_id}::uuid, ${args.row.order_id}::uuid,
      ${args.reminderType}::text, ${args.channel}::text, ${args.target || 'unknown'}::text,
      'skipped', ${args.reason}::text, ${args.triggeredBy}::text, ${args.triggeredByUserId}::uuid
    )
  `;
}

// Send via one channel. Returns 'sent' | 'failed' | 'skipped'.
async function sendVia(args: {
  ws: WorkspaceRow;
  row: EligibleRow;
  reminderType: ReminderType;
  channel: Channel;
  template: any;
  whatsappAdapter: LoadedAdapter<WhatsAppAdapter> | null;
  emailAdapter: LoadedAdapter<EmailAdapter> | null;
  triggeredBy: string;
  triggeredByUserId: string | null;
}): Promise<{ status: 'sent' | 'failed' | 'skipped'; error?: string }> {
  const { ws, row, channel } = args;
  const ctx = buildContext(row, ws);

  if (channel === 'whatsapp') {
    if (!args.whatsappAdapter) { await logSkip({ ...args, target: row.phone || '', reason: 'no_adapter' }); return { status: 'skipped' }; }
    if (!row.phone) { await logSkip({ ...args, target: '', reason: 'no_contact' }); return { status: 'skipped' }; }

    const wa = args.template?.whatsapp ?? {};
    const templateName = wa.template_name || '';
    const variables: Record<string, string> = {};
    for (const name of (wa.variable_order ?? []) as string[]) variables[name] = ctx[name] ?? '';

    const insertedRows = await query<{ id: string }>(sql`
      INSERT INTO invoice_reminders
        (workspace_id, invoice_id, order_id, reminder_type, channel, target_address,
         template_name, template_variables, status, provider, triggered_by, triggered_by_user_id)
      VALUES (
        ${ws.id}::uuid, ${row.invoice_id}::uuid, ${row.order_id}::uuid, ${args.reminderType}::text,
        'whatsapp', ${row.phone}::text, ${templateName}::text, ${JSON.stringify(variables)}::jsonb,
        'queued', ${args.whatsappAdapter.provider}::text, ${args.triggeredBy}::text, ${args.triggeredByUserId}::uuid
      )
      RETURNING id
    `);
    const reminderId = insertedRows[0]!.id;

    const result = await args.whatsappAdapter.adapter.sendTemplate({
      to: row.phone,
      templateName,
      variables,
      credentials: args.whatsappAdapter.credentials,
      config: args.whatsappAdapter.config,
    });
    await finalizeReminder(reminderId, ws, row, 'whatsapp', args.whatsappAdapter.provider, result, args.triggeredByUserId);
    return { status: result.status === 'sent' ? 'sent' : 'failed', error: result.error };
  }

  // email
  if (!args.emailAdapter) { await logSkip({ ...args, target: row.email || '', reason: 'no_adapter' }); return { status: 'skipped' }; }
  if (!row.email) { await logSkip({ ...args, target: '', reason: 'no_contact' }); return { status: 'skipped' }; }

  const em = args.template?.email ?? {};
  const subject = substitute(em.subject || 'Invoice reminder', ctx);
  const body = substitute(em.body || '', ctx);
  const html = `<pre style="font-family:inherit;white-space:pre-wrap;margin:0;">${escapeHtml(body)}</pre>`;

  const insertedRows = await query<{ id: string }>(sql`
    INSERT INTO invoice_reminders
      (workspace_id, invoice_id, order_id, reminder_type, channel, target_address,
       subject_snapshot, body_snapshot, status, provider, triggered_by, triggered_by_user_id)
    VALUES (
      ${ws.id}::uuid, ${row.invoice_id}::uuid, ${row.order_id}::uuid, ${args.reminderType}::text,
      'email', ${row.email}::text, ${subject}::text, ${body}::text,
      'queued', ${args.emailAdapter.provider}::text, ${args.triggeredBy}::text, ${args.triggeredByUserId}::uuid
    )
    RETURNING id
  `);
  const reminderId = insertedRows[0]!.id;

  const result = await args.emailAdapter.adapter.send({
    to: row.email,
    from: String(args.emailAdapter.config.from_email || ws.business_email || ''),
    fromName: ctx.workspace_name,
    subject,
    html,
    text: body,
    credentials: args.emailAdapter.credentials,
    config: args.emailAdapter.config,
  });
  await finalizeReminder(reminderId, ws, row, 'email', args.emailAdapter.provider, result, args.triggeredByUserId);
  return { status: result.status === 'sent' ? 'sent' : 'failed', error: result.error };
}

async function finalizeReminder(
  reminderId: string,
  ws: WorkspaceRow,
  row: EligibleRow,
  channel: Channel,
  provider: string,
  result: { status: 'sent' | 'failed'; messageId?: string; error?: string },
  actorUserId: string | null,
): Promise<void> {
  const sent = result.status === 'sent';
  await sql`
    UPDATE invoice_reminders SET
      status = ${sent ? 'sent' : 'failed'}::text,
      provider_message_id = ${result.messageId ?? null}::text,
      error_message = ${result.error ?? null}::text,
      sent_at = ${sent ? new Date().toISOString() : null}::timestamptz
    WHERE id = ${reminderId}::uuid
  `;
  await audit({
    workspaceId: ws.id,
    actorUserId,
    eventType: sent ? 'invoices.reminder.sent' : 'invoices.reminder.failed',
    targetType: 'invoice',
    targetId: row.invoice_id,
    payload: { invoice_number: row.invoice_number, channel, provider, error: result.error ?? null },
  });
  if (sent) {
    emitNotification({
      workspaceId: ws.id,
      actorUserId,
      eventType: 'invoice.reminder.sent',
      targetType: 'invoice', targetId: row.invoice_id,
      linkUrl: `/invoice.html?id=${row.invoice_id}&order=${row.order_id}`,
      metadata: { invoice_number: row.invoice_number, customer_name: row.display_name ?? '', channel },
    }).catch(() => {});
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Try each channel in priority order; stop at the first successful send.
async function sendWithFallback(args: {
  ws: WorkspaceRow;
  row: EligibleRow;
  reminderType: ReminderType;
  template: any;
  channels: Channel[];
  whatsappAdapter: LoadedAdapter<WhatsAppAdapter> | null;
  emailAdapter: LoadedAdapter<EmailAdapter> | null;
  triggeredBy: string;
  triggeredByUserId: string | null;
}): Promise<{ status: 'sent' | 'skipped'; channel?: string; detail: string[] }> {
  const detail: string[] = [];
  for (const channel of args.channels) {
    const r = await sendVia({ ...args, channel });
    if (r.status === 'sent') return { status: 'sent', channel, detail };
    detail.push(`${channel}:${r.status}${r.error ? ` (${r.error})` : ''}`);
  }
  return { status: 'skipped', detail };
}

// ============================================================================
// POST /api/reminders/trigger — cron entry (X-Reminder-Secret auth)
// ============================================================================
reminders.post('/trigger', async (c) => {
  const secret = process.env.REMINDER_TRIGGER_SECRET;
  const provided = c.req.header('x-reminder-secret');
  if (!secret || !provided || provided !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const summary = {
    workspaces_processed: 0,
    reminders_sent: 0,
    reminders_skipped: 0,
    reminders_failed: 0,
    errors: [] as string[],
  };

  const wsRows = await query<WorkspaceRow>(sql`
    SELECT id, legal_name, business_email, business_phone, settings,
           settings->'reminders'->>'sender_name' AS "reminderSenderName"
    FROM workspaces
  `);

  for (const ws of wsRows) {
    summary.workspaces_processed++;
    try {
      const cfg = ws.settings?.reminders?.templates ?? {};
      const whatsappAdapter = await loadActiveAdapter<WhatsAppAdapter>(ws.id, 'whatsapp');
      const emailAdapter = await loadActiveAdapter<EmailAdapter>(ws.id, 'email');

      const jobs: Array<{ type: ReminderType; template: any; rows: EligibleRow[] }> = [];

      const up = cfg.invoice_upcoming;
      if (up?.enabled) {
        jobs.push({ type: 'invoice_upcoming', template: up, rows: await findUpcoming(ws, Number(up.days_before_due ?? 3)) });
      }
      const ov = cfg.invoice_overdue;
      if (ov?.enabled) {
        jobs.push({ type: 'invoice_overdue', template: ov, rows: await findOverdue(ws, Number(ov.days_after_due ?? 3), Number(ov.repeat_every_days ?? 7)) });
      }

      for (const job of jobs) {
        const channels = (job.template.channels ?? []) as Channel[];
        for (const row of job.rows) {
          const res = await sendWithFallback({
            ws, row, reminderType: job.type, template: job.template, channels,
            whatsappAdapter, emailAdapter, triggeredBy: 'cron', triggeredByUserId: null,
          });
          if (res.status === 'sent') summary.reminders_sent++;
          else summary.reminders_skipped++;
        }
      }
    } catch (err: any) {
      summary.errors.push(`${ws.id}: ${err?.message || String(err)}`);
    }
  }

  return c.json(summary);
});

// ============================================================================
// Session-guarded invoice-scoped routes
// ============================================================================
async function loadInvoiceForReminder(invoiceId: string, workspaceId: string): Promise<EligibleRow | null> {
  const rows = await query<EligibleRow>(sql`
    SELECT i.id AS invoice_id, i.invoice_number, i.total_paise, i.order_id, i.status::text AS status,
           i.due_date, o.order_number, o.rental_start, o.rental_end,
           p.id AS customer_id, p.display_name, p.phone, p.email
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    JOIN people p ON p.id = o.customer_person_id
    WHERE i.id = ${invoiceId}::uuid AND i.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadWorkspaceRow(workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = await query<WorkspaceRow>(sql`
    SELECT id, legal_name, business_email, business_phone, settings,
           settings->'reminders'->>'sender_name' AS "reminderSenderName"
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0] ?? null;
}

const manualSchema = z.object({
  channel: z.enum(['whatsapp', 'email']).optional(),
});

reminders.post('/invoices/:invoiceId/send', sessionMiddleware, requireAuth, requirePermission('invoices.manage'), async (c) => {
  const session = c.get('session')!;
  const invoiceId = c.req.param('invoiceId');

  const body = await c.req.json().catch(() => ({}));
  const parsed = manualSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const ws = await loadWorkspaceRow(session.workspace.id);
  const row = await loadInvoiceForReminder(invoiceId, session.workspace.id);
  if (!ws || !row) return c.json({ error: 'not_found' }, 404);

  // Manual auto-detects the template by due status; forceChannel overrides priority.
  const dd = defaultDueDays(ws);
  const effectiveDue = row.due_date ?? new Date(new Date().getTime() + dd * 86400000).toISOString();
  const isOverdue = new Date(effectiveDue).getTime() < Date.now();
  // Resolve the effective due date onto the row so context renders it.
  row.due_date = row.due_date ?? effectiveDue;
  const type: ReminderType = 'manual';
  const templateKey = isOverdue ? 'invoice_overdue' : 'invoice_upcoming';
  const template = ws.settings?.reminders?.templates?.[templateKey] ?? { channels: ['whatsapp', 'email'] };

  const whatsappAdapter = await loadActiveAdapter<WhatsAppAdapter>(session.workspace.id, 'whatsapp');
  const emailAdapter = await loadActiveAdapter<EmailAdapter>(session.workspace.id, 'email');

  const channels: Channel[] = parsed.data.channel ? [parsed.data.channel] : ((template.channels ?? ['whatsapp', 'email']) as Channel[]);

  const res = await sendWithFallback({
    ws, row, reminderType: type, template, channels,
    whatsappAdapter, emailAdapter, triggeredBy: 'manual', triggeredByUserId: session.user.id,
  });

  if (res.status === 'sent') {
    return c.json({ status: 'sent', channel: res.channel });
  }
  return c.json({ status: 'skipped', reason: res.detail.join('; ') || 'no_channel_available' }, 200);
});

reminders.get('/invoices/:invoiceId', sessionMiddleware, requireAuth, async (c) => {
  const session = c.get('session')!;
  const invoiceId = c.req.param('invoiceId');

  const rows = await query<Record<string, unknown>>(sql`
    SELECT r.id, r.reminder_type, r.channel, r.target_address, r.subject_snapshot,
           r.template_name, r.status, r.provider, r.provider_message_id, r.error_message,
           r.skip_reason, r.triggered_by, u.display_name AS triggered_by_name,
           r.sent_at, r.created_at
    FROM invoice_reminders r
    LEFT JOIN users u ON u.id = r.triggered_by_user_id
    WHERE r.invoice_id = ${invoiceId}::uuid AND r.workspace_id = ${session.workspace.id}::uuid
    ORDER BY r.created_at DESC
    LIMIT 100
  `);
  return c.json({ reminders: rows });
});
