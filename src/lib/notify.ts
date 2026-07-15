import { sql, query } from '../db.js';
import { decryptJson } from './crypto.js';
import { findAdapter } from './adapters/registry.js';
import type { EmailAdapter } from './adapters/types.js';

// ============================================================================
// Email dispatch (Sub-slice 2.1.5)
// ----------------------------------------------------------------------------
// Wires the SMTP adapter into the emit pipeline so notifications actually SEND
// (2.1 only recorded delivery intent). Same loader/render pattern as reminders.ts.
// WhatsApp is deliberately NOT wired here — it stays delivery-intent-only until a
// future WATI slice. Every path is fail-open: a send error is logged on the
// delivery row and never breaks the business action.
// ============================================================================
type LoadedEmail = { provider: string; adapter: EmailAdapter; credentials: Record<string, string>; config: Record<string, unknown>; credentialError?: string };

async function loadActiveEmailAdapter(workspaceId: string): Promise<LoadedEmail | null> {
  try {
    const rows = await query<{ provider: string; credentials_b64: string | null; config: Record<string, unknown> }>(sql`
      SELECT provider, encode(credentials_encrypted, 'base64') AS credentials_b64, config
      FROM workspace_integrations
      WHERE workspace_id = ${workspaceId}::uuid AND category = 'email' AND is_active = true
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    const adapter = findAdapter('email', row.provider) as EmailAdapter | null;
    if (!adapter) return null;
    let credentials: Record<string, string> = {};
    let credentialError: string | undefined;
    if (row.credentials_b64) {
      // Do NOT silently fall through with empty credentials on a decrypt failure —
      // that produces a confusing downstream auth error. Flag it so the send is
      // recorded with an explicit, actionable message.
      try { credentials = (decryptJson(Buffer.from(row.credentials_b64, 'base64')) as Record<string, string>) ?? {}; }
      catch (err) {
        console.error('[notify] credential decrypt failed', err);
        credentialError = 'SMTP_DECRYPTION_FAILED: encryption key mismatch or corrupted credentials — re-save the integration (INTEGRATION_ENC_KEY may have changed).';
      }
    }
    return { provider: row.provider, adapter, credentials, config: row.config ?? {}, credentialError };
  } catch (err) {
    console.error('[notify] loadActiveEmailAdapter failed', err);
    return null;
  }
}

/** {var} substitution — unknown tokens are left literal so a typo is visible. */
function substitute(text: string, vars: Record<string, unknown>): string {
  return String(text).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k] ?? '') : `{${k}}`));
}
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Resolve the email template (subject/body) for an event from workspace settings. */
function emailTemplateFor(settings: Record<string, any> | null | undefined, eventType: string): { subject: string; body: string } | null {
  const t = settings?.notification_policy?.templates?.[eventType]?.email;
  if (t && (t.subject || t.body)) return { subject: String(t.subject ?? ''), body: String(t.body ?? '') };
  return null;
}

type WsInfo = { name: string; business_email: string | null };
async function loadWorkspaceInfo(workspaceId: string): Promise<WsInfo> {
  try {
    const rows = await query<WsInfo>(sql`SELECT name, business_email FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1`);
    return rows[0] ?? { name: 'RentalOS', business_email: null };
  } catch { return { name: 'RentalOS', business_email: null }; }
}

/** Send one email via the active adapter. Returns the adapter result (never throws). */
async function sendEmail(loaded: LoadedEmail, args: { to: string; subject: string; body: string; ws: WsInfo }): Promise<{ status: 'sent' | 'failed'; messageId?: string; error?: string }> {
  // A decrypt failure is surfaced explicitly, never sent with empty credentials.
  if (loaded.credentialError) return { status: 'failed', error: loaded.credentialError };
  try {
    const html = `<pre style="font-family:inherit;white-space:pre-wrap;margin:0;">${escapeHtml(args.body)}</pre>`;
    return await loaded.adapter.send({
      to: args.to,
      from: String(loaded.config.from_email || args.ws.business_email || ''),
      fromName: args.ws.name,
      subject: args.subject,
      html,
      text: args.body,
      credentials: loaded.credentials,
      config: loaded.config,
    });
  } catch (err: any) {
    return { status: 'failed', error: err?.message || String(err) };
  }
}

// ============================================================================
// src/lib/notify.ts  (Sub-turn 5d)
// ----------------------------------------------------------------------------
// emitNotification() fans an event out to every OTHER active member of the
// workspace (the actor never notifies themselves), writing one `notifications`
// row + one `notification_deliveries` row (channel='in_product', status='sent')
// per recipient.
//
// FAIL-OPEN: notifications must never break the business action that triggered
// them. The whole body is wrapped in try/catch and swallows errors to console.
//
// Templates are hardcoded here (per 5d). notification_templates exists in the
// schema for future per-workspace overrides but isn't consulted yet.
// ============================================================================

export type NotifyArgs = {
  workspaceId: string;
  actorUserId: string | null; // null for system-triggered
  eventType: string;
  targetType?: string;
  targetId?: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
  // Sub-slice 2.1.5 follow-up — when set, the EMAIL for this event goes ONLY to
  // this user (approver for *_pending_approval, requester for approval_*), not to
  // every member. In-product bell notifications still fan out to all members.
  // When null/undefined, email falls back to all template-eligible recipients
  // (e.g. a role-gated approval with no specific approver routed).
  emailRecipientUserId?: string | null;
};

type ActiveIntegration = {
  provider: string;
  is_active: boolean;
};

/**
 * Load the active adapter for a category in this workspace, if any. Returns null
 * when nothing is active. Never throws — a lookup failure must not break the
 * in-product notification that already succeeded.
 */
async function loadActiveIntegration(
  workspaceId: string,
  category: 'whatsapp' | 'email',
): Promise<ActiveIntegration | null> {
  try {
    const rows = await query<ActiveIntegration>(sql`
      SELECT provider, is_active
      FROM workspace_integrations
      WHERE workspace_id = ${workspaceId}::uuid
        AND category = ${category}::text
        AND is_active = true
      LIMIT 1
    `);
    return rows[0] ?? null;
  } catch (err) {
    console.error('loadActiveIntegration failed:', err, category);
    return null;
  }
}

const TEMPLATES: Record<string, { title: string; body?: string }> = {
  'order.created': {
    title: 'New order #{order_number}',
    body: 'Draft created for {customer_name}',
  },
  'order.status.changed': {
    title: 'Order #{order_number} → {new_status}',
    body: 'Moved from {old_status}. Customer: {customer_name}',
  },
  'order.status.forced': {
    title: 'Order #{order_number} force-moved to {new_status}',
    body: 'Reason: {reason}',
  },
  'order.extended': {
    title: 'Order #{order_number} extended by {delta_days} day(s)',
    body: 'Customer: {customer_name}. Extended by {actor_name}.',
  },
  'order.item.dispatched': {
    title: '{count} items dispatched on Order #{order_number}',
    body: 'Handed to {handed_to} by {actor_name}',
  },
  'order.item.returned': {
    title: '{count} items returned on Order #{order_number}',
    body: '{customer_name} returned {count} items',
  },
  'order.item.status.changed': {
    title: 'Item status changed on Order #{order_number}',
    body: '{item_description}: {old_status} → {new_status}',
  },
  'payment.recorded': {
    title: 'Payment received: ₹{amount}',
    body: 'Order #{order_number} from {customer_name} via {method}',
  },
  'payment.refunded': {
    title: 'Refund issued: ₹{amount}',
    body: 'Order #{order_number} via {method}',
  },
  'payment.deleted': {
    title: 'Payment deleted on Order #{order_number}',
    body: 'Amount was ₹{amount}',
  },
  'invoice.generated': {
    title: 'Invoice {invoice_number} generated',
    body: 'Order #{order_number} · ₹{amount}',
  },
  'invoice.status.changed': {
    title: 'Invoice {invoice_number} → {new_status}',
    body: 'Order #{order_number}',
  },
  'invoice.reminder.sent': {
    title: 'Reminder sent for Invoice {invoice_number}',
    body: '{customer_name} · via {channel}',
  },
  'people.communication.logged': {
    title: 'Communication logged for {customer_name}',
    body: '{channel} · {direction}',
  },
  'order.coupon.applied': {
    title: 'Coupon {code} applied to Order #{order_number}',
    body: '{customer_name} · ₹{discount} off',
  },
  // Sub-slice 2.1 — extensions / cancellations / approvals (internal staff feed).
  'order.cancelled': {
    title: 'Order #{order_number} cancelled',
    body: '{customer_name} · {reason_tag}',
  },
  'extension_pending_approval': {
    title: 'Extension needs approval · Order #{order_number}',
    body: '+{delta_days} day(s), ₹{additional_charges}. Requested by {actor_name}.',
  },
  'cancellation_pending_approval': {
    title: 'Cancellation needs approval · Order #{order_number}',
    body: 'Refund ₹{refund_amount}. Requested by {actor_name}.',
  },
  'approval_required': {
    title: 'Approval needed: {resource_label} · Order #{order_number}',
    body: 'Requested by {actor_name}. Review to approve or reject.',
  },
  'approval_approved': {
    title: 'Approved: {resource_label} · Order #{order_number}',
    body: 'Approved by {actor_name}.',
  },
  'approval_rejected': {
    title: 'Rejected: {resource_label} · Order #{order_number}',
    body: 'Rejected by {actor_name}.{reason_suffix}',
  },
};

// ============================================================================
// Customer-facing notifications (Sub-slice 2.1, N1 pipeline).
// ----------------------------------------------------------------------------
// Internal notifications (above) go to workspace users. These go to the CUSTOMER
// over WhatsApp/email. Our schema is user-centric, so a customer send is recorded
// as a notification_deliveries row with notification_id NULL + target_person_id
// set (no notifications row). The Order 360 Communications card reads these back
// by payload_snapshot->>'order_id'.
//
// Policy modes live at settings.notification_policy.events[event_type].mode:
//   off            → no send
//   manual_only    → auto path is a no-op (only the Send Update modal fires it)
//   auto           → record a delivery per active-adapter channel (default)
//   auto_with_review → recorded as 'pending' (a human clicks Send later)
// A missing policy defaults to 'auto'. Honest scope (matches 6a): we RECORD the
// delivery intent; a real sender worker lands in a later sub-slice. Fail-open.
// ============================================================================

export type CustomerChannel = 'whatsapp' | 'email';

export type CustomerNotifyResult = {
  mode: string;
  deliveries: Array<{ channel: CustomerChannel; status: 'pending' | 'skipped' | 'sent' | 'failed'; reason?: string; provider_ref?: string | null }>;
};

function notificationMode(settings: Record<string, any> | null | undefined, eventType: string): string {
  const m = settings?.notification_policy?.events?.[eventType]?.mode;
  return typeof m === 'string' ? m : 'auto';
}

/** Record one customer delivery row (notification_id NULL). Never throws. */
async function recordCustomerDelivery(args: {
  workspaceId: string;
  orderId: string;
  personId: string | null;
  channel: CustomerChannel;
  status: 'pending' | 'skipped' | 'sent' | 'failed';
  address: string | null;
  message: string;
  eventType: string;
  errorMessage?: string | null;
  providerRef?: string | null;
}): Promise<void> {
  const deliveredAt = args.status === 'sent' ? new Date().toISOString() : null;
  await sql`
    INSERT INTO notification_deliveries (
      workspace_id, notification_id, channel, status,
      target_user_id, target_person_id, target_address, payload_snapshot,
      error_message, provider_ref, delivered_at
    ) VALUES (
      ${args.workspaceId}::uuid, NULL, ${args.channel}::text, ${args.status}::text,
      NULL, ${args.personId ?? null}::uuid, ${args.address ?? null}::text,
      ${JSON.stringify({ order_id: args.orderId, event_type: args.eventType, message: args.message })}::jsonb,
      ${args.errorMessage ?? null}::text, ${args.providerRef ?? null}::text, ${deliveredAt}::timestamptz
    )
  `;
}

/**
 * Send a customer-facing notification for a business event, honoring the
 * workspace notification policy. `channels` is the requested set; a channel is
 * skipped (recorded) when it has no active adapter or the customer lacks that
 * contact method. `bypassPolicy` (manual Send Update) forces the send. Never
 * throws — a notification must not break the action that triggered it.
 */
export async function emitCustomerNotification(args: {
  workspaceId: string;
  orderId: string;
  personId: string | null;
  eventType: string;
  message: string;
  channels: CustomerChannel[];
  contact: { phone?: string | null; email?: string | null };
  settings?: Record<string, any> | null;
  bypassPolicy?: boolean;
  // Sub-slice 2.1.5 — merge fields for the email template (falls back to `message`).
  variables?: Record<string, unknown>;
}): Promise<CustomerNotifyResult> {
  const result: CustomerNotifyResult = { mode: 'auto', deliveries: [] };
  try {
    const settings = args.settings ?? (await loadWorkspaceSettingsSafe(args.workspaceId));
    const mode = args.bypassPolicy ? 'manual' : notificationMode(settings, args.eventType);
    result.mode = mode;
    if (!args.bypassPolicy && (mode === 'off' || mode === 'manual_only')) return result;

    // Sub-slice 2.1.5: the EMAIL channel now actually dispatches via SMTP. WhatsApp
    // stays delivery-intent-only (recorded, not sent) until the WATI slice.
    const [wa, emailLoaded, wsInfo] = await Promise.all([
      loadActiveIntegration(args.workspaceId, 'whatsapp'),
      loadActiveEmailAdapter(args.workspaceId),
      loadWorkspaceInfo(args.workspaceId),
    ]);
    const vars: Record<string, unknown> = { workspace_name: wsInfo.name, ...(args.variables ?? {}) };
    const tpl = emailTemplateFor(settings, args.eventType);

    for (const channel of args.channels) {
      const address = channel === 'whatsapp' ? args.contact.phone ?? null : args.contact.email ?? null;
      let status: 'pending' | 'skipped' | 'sent' | 'failed' = 'skipped';
      let reason: string | undefined;
      let providerRef: string | null = null;

      if (channel === 'email') {
        if (!address) { status = 'skipped'; reason = 'no_contact_method'; }
        else if (!emailLoaded) { status = 'skipped'; reason = 'no_active_adapter'; }
        else if (emailLoaded.provider === 'noop') { status = 'skipped'; reason = 'noop_adapter'; }
        else if (mode === 'auto_with_review') { status = 'pending'; reason = 'awaiting_review'; }
        else {
          const subject = tpl ? substitute(tpl.subject, vars) : `Update on your order #${vars.order_number ?? ''}`;
          const body = tpl ? substitute(tpl.body, vars) : args.message;
          const r = await sendEmail(emailLoaded, { to: address, subject, body, ws: wsInfo });
          status = r.status === 'sent' ? 'sent' : 'failed';
          providerRef = r.messageId ?? null;
          reason = r.error ?? undefined;
        }
      } else {
        // whatsapp — record intent only.
        if (!address) { status = 'skipped'; reason = 'no_contact_method'; }
        else if (!wa) { status = 'skipped'; reason = 'no_active_adapter'; }
        else if (wa.provider === 'noop') { status = 'skipped'; reason = 'noop_adapter'; }
        else { status = 'pending'; reason = 'whatsapp_not_wired'; }
      }

      await recordCustomerDelivery({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: args.personId,
        channel, status, address, message: args.message, eventType: args.eventType,
        errorMessage: reason ?? null, providerRef,
      });
      result.deliveries.push({ channel, status, reason, provider_ref: providerRef });
    }
  } catch (err) {
    console.error('emitCustomerNotification failed:', err, args.eventType);
  }
  return result;
}

/** Load settings without throwing (a lookup failure just yields {}). */
async function loadWorkspaceSettingsSafe(workspaceId: string): Promise<Record<string, any>> {
  try {
    const rows = await query<{ settings: Record<string, any> | null }>(sql`
      SELECT settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
    `);
    return (rows[0]?.settings ?? {}) as Record<string, any>;
  } catch {
    return {};
  }
}

function renderTemplate(
  eventType: string,
  metadata: Record<string, unknown>,
): { title: string; body: string | null } {
  const template = TEMPLATES[eventType];
  if (!template) return { title: eventType, body: null };
  const fill = (str: string) =>
    str.replace(/\{(\w+)\}/g, (_, key) => String(metadata[key] ?? `?${key}`));
  return {
    title: fill(template.title),
    body: template.body ? fill(template.body) : null,
  };
}

/**
 * Fan an event out to every other active member of the workspace. Never throws.
 */
export async function emitNotification(args: NotifyArgs): Promise<void> {
  try {
    const metadata = args.metadata ?? {};
    const { title, body } = renderTemplate(args.eventType, metadata);
    const metaJson = JSON.stringify(metadata);

    // Active members except the actor (with their email for SMTP dispatch).
    const recipients = await query<{ user_id: string; email: string | null; display_name: string | null }>(sql`
      SELECT m.user_id, u.email, u.display_name
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${args.workspaceId}::uuid
        AND m.status = 'active'
        AND u.deleted_at IS NULL
        AND (${args.actorUserId ?? null}::uuid IS NULL OR m.user_id != ${args.actorUserId ?? null}::uuid)
    `);

    // WhatsApp stays delivery-intent-only (Sub-turn 6a posture): a noop adapter
    // records 'skipped', a real one 'pending' for a future sender. EMAIL now
    // actually dispatches (Sub-slice 2.1.5) when the event has a configured
    // template — so only approval-vocabulary events email, not every in-product
    // ping. Adapters/template/workspace loaded once per emit, not per recipient.
    const waIntegration = await loadActiveIntegration(args.workspaceId, 'whatsapp');
    const externalChannels: Array<{ channel: 'whatsapp'; status: 'pending' | 'skipped' }> = [];
    if (waIntegration) {
      externalChannels.push({ channel: 'whatsapp', status: waIntegration.provider === 'noop' ? 'skipped' : 'pending' });
    }
    const [emailLoaded, wsInfo, settings] = await Promise.all([
      loadActiveEmailAdapter(args.workspaceId),
      loadWorkspaceInfo(args.workspaceId),
      loadWorkspaceSettingsSafe(args.workspaceId),
    ]);
    const emailTpl = emailTemplateFor(settings, args.eventType);
    const emailVars = { workspace_name: wsInfo.name, link_url: args.linkUrl ?? '', ...metadata };

    for (const r of recipients) {
      const inserted = await query<{ id: string }>(sql`
        INSERT INTO notifications (
          workspace_id, recipient_user_id, actor_user_id, event_type,
          target_type, target_id, title, body, link_url, metadata
        ) VALUES (
          ${args.workspaceId}::uuid,
          ${r.user_id}::uuid,
          ${args.actorUserId ?? null}::uuid,
          ${args.eventType}::text,
          ${args.targetType ?? null}::text,
          ${args.targetId ?? null}::uuid,
          ${title}::text,
          ${body}::text,
          ${args.linkUrl ?? null}::text,
          ${metaJson}::jsonb
        )
        RETURNING id
      `);
      const notificationId = inserted[0]?.id;
      if (!notificationId) continue;

      // In-product delivery is immediate. WhatsApp/email/sms adapters land later;
      // their rows will be enqueued as 'pending' then. For now, in_product only.
      await sql`
        INSERT INTO notification_deliveries (
          workspace_id, notification_id, channel, status, target_user_id, payload_snapshot
        ) VALUES (
          ${args.workspaceId}::uuid,
          ${notificationId}::uuid,
          'in_product',
          'sent',
          ${r.user_id}::uuid,
          ${JSON.stringify({ title, body, link_url: args.linkUrl ?? null })}::jsonb
        )
      `;

      // WhatsApp: record delivery intent only (not wired).
      for (const ext of externalChannels) {
        await sql`
          INSERT INTO notification_deliveries (
            workspace_id, notification_id, channel, status, target_user_id, payload_snapshot
          ) VALUES (
            ${args.workspaceId}::uuid, ${notificationId}::uuid, ${ext.channel}::text,
            ${ext.status}::text, ${r.user_id}::uuid,
            ${JSON.stringify({ title, body, link_url: args.linkUrl ?? null })}::jsonb
          )
        `;
      }

      // Email: actually dispatch via SMTP when a real adapter + template + the
      // recipient's address are all present. Otherwise record intent (skipped).
      // Targeting: when emailRecipientUserId is set, email ONLY that user (no CC
      // to other members) — approver for *_pending_approval, requester for
      // approval_*. Others are skipped silently (no email row, no alert fatigue).
      const emailTargeted = args.emailRecipientUserId ?? null;
      const emailThisRecipient = !emailTargeted || r.user_id === emailTargeted;
      if (emailLoaded && emailThisRecipient) {
        let status: 'pending' | 'skipped' | 'sent' | 'failed' = 'skipped';
        let reason: string | null = null;
        let providerRef: string | null = null;
        if (emailLoaded.provider === 'noop') { status = 'skipped'; reason = 'noop_adapter'; }
        else if (!emailTpl) { status = 'skipped'; reason = 'no_template'; }
        else if (!r.email) { status = 'skipped'; reason = 'no_contact_method'; }
        else {
          const subject = substitute(emailTpl.subject, emailVars);
          const emailBody = substitute(emailTpl.body, emailVars);
          const sr = await sendEmail(emailLoaded, { to: r.email, subject, body: emailBody, ws: wsInfo });
          status = sr.status === 'sent' ? 'sent' : 'failed';
          providerRef = sr.messageId ?? null;
          reason = sr.error ?? null;
        }
        const deliveredAt = status === 'sent' ? new Date().toISOString() : null;
        await sql`
          INSERT INTO notification_deliveries (
            workspace_id, notification_id, channel, status, target_user_id,
            target_address, payload_snapshot, error_message, provider_ref, delivered_at
          ) VALUES (
            ${args.workspaceId}::uuid, ${notificationId}::uuid, 'email', ${status}::text,
            ${r.user_id}::uuid, ${r.email ?? null}::text,
            ${JSON.stringify({ title, body, link_url: args.linkUrl ?? null })}::jsonb,
            ${reason}::text, ${providerRef}::text, ${deliveredAt}::timestamptz
          )
        `;
      }
    }
  } catch (err) {
    console.error('emitNotification failed:', err, args.eventType);
  }
}
