import { Hono } from 'hono';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification, emitCustomerNotification } from '../lib/notify.js';
import { releaseStandbyHold } from '../lib/standby.js';
import { config } from '../lib/config.js';

// ============================================================================
// src/routes/cron.ts (Sub-slice 2.2) — background jobs (secret-header auth)
// ----------------------------------------------------------------------------
//   POST /api/cron/standby-tick   every 15 min — expire holds + fire reminders
//   POST /api/cron/quote-tick     daily        — expire quotes + expiring reminders
// Auth: header X-Reminder-Secret == REMINDER_TRIGGER_SECRET (reuses the existing
// secret already provisioned for invoice reminders). No session. Idempotent +
// self-throttling (per-row sent-at flags), so re-running is safe.
// ============================================================================
export const cron = new Hono();

function authed(c: any): boolean {
  const secret = process.env.REMINDER_TRIGGER_SECRET;
  return !!secret && c.req.header('X-Reminder-Secret') === secret;
}
function inr(paise: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(paise) / 100));
}
function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso);
  return isNaN(t.getTime()) ? '' : t.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

type WS = { id: string; name: string; settings: Record<string, any> | null };
async function allWorkspaces(): Promise<WS[]> {
  return await query<WS>(sql`SELECT id, name, settings FROM workspaces WHERE deleted_at IS NULL`);
}

// ----------------------------------------------------------------------------
// POST /api/cron/standby-tick
// ----------------------------------------------------------------------------
cron.post('/standby-tick', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  let expired = 0, customerReminders = 0, staffReminders = 0;

  for (const ws of await allWorkspaces()) {
    const pol = ws.settings?.standby_policy ?? {};
    const custBefore = Number(pol.reminders?.customer_before_expiry_minutes ?? 60);
    const staffBefore = Number(pol.reminders?.staff_before_expiry_minutes ?? 15);
    const reclaim = Number(pol.on_expiry?.customer_reclaim_grace_minutes ?? 30);

    // 1) Expire overdue active holds → release availability + notify.
    const overdue = await query<any>(sql`
      SELECT s.id, s.standby_number, s.customer_id, p.display_name AS customer_name, p.phone, p.email
      FROM standbys s JOIN people p ON p.id = s.customer_id
      WHERE s.workspace_id = ${ws.id}::uuid AND s.status = 'active' AND s.expires_at < now()
      LIMIT 200
    `);
    for (const s of overdue) {
      await releaseStandbyHold({ workspaceId: ws.id, standbyId: s.id, actorUserId: null, newStatus: 'expired', orderStatus: 'standby_expired', outcomeReason: 'timed_out' });
      await audit({ workspaceId: ws.id, actorUserId: null, eventType: 'standbys.expired', targetType: 'standby', targetId: s.id, payload: { standby_number: s.standby_number }, ipAddress: null, userAgent: null });
      if (pol.on_expiry?.customer_notification !== false) {
        emitCustomerNotification({
          workspaceId: ws.id, orderId: '', personId: s.customer_id, eventType: 'standby_expired',
          message: `Your hold ${s.standby_number} has expired and the equipment was released.`,
          channels: ['whatsapp', 'email'], contact: { phone: s.phone, email: s.email }, settings: ws.settings,
          variables: { customer_name: s.customer_name ?? 'there', standby_number: s.standby_number, reclaim_minutes: reclaim, workspace_name: ws.name },
        }).catch(() => {});
      }
      expired++;
    }

    // 2) Customer reminder — N min before expiry, once.
    const custDue = await query<any>(sql`
      SELECT s.id, s.standby_number, s.customer_id, s.expires_at, s.line_items_snapshot, p.display_name AS customer_name, p.phone, p.email
      FROM standbys s JOIN people p ON p.id = s.customer_id
      WHERE s.workspace_id = ${ws.id}::uuid AND s.status = 'active' AND s.customer_reminder_sent_at IS NULL
        AND s.expires_at > now() AND s.expires_at <= now() + make_interval(mins => ${custBefore}::int)
      LIMIT 200
    `);
    for (const s of custDue) {
      const items = Array.isArray(s.line_items_snapshot) ? s.line_items_snapshot.map((li: any) => li.name).filter(Boolean).join(', ') : '';
      emitCustomerNotification({
        workspaceId: ws.id, orderId: '', personId: s.customer_id, eventType: 'standby_expiring',
        message: `Your hold ${s.standby_number} expires at ${fmtTime(s.expires_at)}. Let us know if you'd like to confirm.`,
        channels: ['whatsapp', 'email'], contact: { phone: s.phone, email: s.email }, settings: ws.settings,
        variables: { customer_name: s.customer_name ?? 'there', standby_number: s.standby_number, items_summary: items, expires_at: fmtTime(s.expires_at), workspace_name: ws.name },
      }).catch(() => {});
      await sql`UPDATE standbys SET customer_reminder_sent_at = now() WHERE id = ${s.id}::uuid`;
      customerReminders++;
    }

    // 3) Staff reminder — N min before expiry, once (internal in-product/email).
    const staffDue = await query<any>(sql`
      SELECT s.id, s.standby_number, s.order_id, o.order_number
      FROM standbys s LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.workspace_id = ${ws.id}::uuid AND s.status = 'active' AND s.staff_reminder_sent_at IS NULL
        AND s.expires_at > now() AND s.expires_at <= now() + make_interval(mins => ${staffBefore}::int)
      LIMIT 200
    `);
    for (const s of staffDue) {
      emitNotification({
        workspaceId: ws.id, actorUserId: null, eventType: 'standby_staff_reminder',
        targetType: 'standby', targetId: s.id, linkUrl: s.order_id ? `/order-360.html?id=${s.order_id}` : undefined,
        metadata: { standby_number: s.standby_number, order_number: s.order_number ?? '' },
      }).catch(() => {});
      await sql`UPDATE standbys SET staff_reminder_sent_at = now() WHERE id = ${s.id}::uuid`;
      staffReminders++;
    }
  }
  return c.json({ ok: true, expired, customer_reminders: customerReminders, staff_reminders: staffReminders });
});

// ----------------------------------------------------------------------------
// POST /api/cron/quote-tick
// ----------------------------------------------------------------------------
cron.post('/quote-tick', async (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  let expired = 0, expiringReminders = 0;

  for (const ws of await allWorkspaces()) {
    const qp = ws.settings?.quote_policy ?? {};
    const beforeDays = Number(qp.notify_customer_before_expiry_days ?? 2);

    // 1) Expiring reminder — N days before valid_until, once.
    const soon = await query<any>(sql`
      SELECT qv.id, qv.order_id, qv.quote_number, qv.total_paise, qv.valid_until, qv.tracking_link_url,
             o.customer_person_id, p.display_name AS customer_name, p.phone, p.email
      FROM quote_versions qv JOIN orders o ON o.id = qv.order_id JOIN people p ON p.id = o.customer_person_id
      WHERE qv.workspace_id = ${ws.id}::uuid AND qv.status IN ('sent','viewed') AND qv.expiry_notified_at IS NULL
        AND qv.valid_until IS NOT NULL AND qv.valid_until > now()
        AND qv.valid_until <= now() + make_interval(days => ${beforeDays}::int)
      LIMIT 200
    `);
    for (const q of soon) {
      const url = q.tracking_link_url ? `${config.appOrigin}/quote-view.html?token=${q.tracking_link_url}` : '';
      emitCustomerNotification({
        workspaceId: ws.id, orderId: q.order_id, personId: q.customer_person_id, eventType: 'quote_expiring',
        message: `Your quote ${q.quote_number} for ${inr(q.total_paise)} expires on ${fmtTime(q.valid_until)}. Accept it here: ${url}`,
        channels: ['whatsapp', 'email'], contact: { phone: q.phone, email: q.email }, settings: ws.settings,
        variables: { customer_name: q.customer_name ?? 'there', quote_number: q.quote_number, total_amount: inr(q.total_paise), valid_until: fmtTime(q.valid_until), tracking_url: url, workspace_name: ws.name },
      }).catch(() => {});
      await sql`UPDATE quote_versions SET expiry_notified_at = now() WHERE id = ${q.id}::uuid`;
      expiringReminders++;
    }

    // 2) Expire past valid_until (if policy).
    if (qp.auto_expire_on_valid_until !== false) {
      const overdue = await query<{ id: string; order_id: string; quote_number: string }>(sql`
        SELECT id, order_id, quote_number FROM quote_versions
        WHERE workspace_id = ${ws.id}::uuid AND status IN ('sent','viewed')
          AND valid_until IS NOT NULL AND valid_until < now() LIMIT 200
      `);
      for (const q of overdue) {
        await sql`UPDATE quote_versions SET status = 'expired', expired_at = now(), tracking_link_url = NULL, updated_at = now() WHERE id = ${q.id}::uuid`;
        await audit({ workspaceId: ws.id, actorUserId: null, eventType: 'quotes.expired', targetType: 'quote_version', targetId: q.id, payload: { order_id: q.order_id, quote_number: q.quote_number }, ipAddress: null, userAgent: null });
        expired++;
      }
    }
  }
  return c.json({ ok: true, expired, expiring_reminders: expiringReminders });
});
