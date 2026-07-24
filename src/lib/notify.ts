import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, query } from '../db.js';
import { config } from './config.js';
import { decryptJson } from './crypto.js';
import { findAdapter } from './adapters/registry.js';
import type { EmailAdapter, WhatsAppAdapter } from './adapters/types.js';

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

/**
 * Send a pre-approved WhatsApp template via the workspace's ACTIVE whatsapp
 * adapter (decrypts credentials the same way the email loader does). Returns
 * `provider_not_configured` when no real WhatsApp integration is active (a noop
 * adapter counts as not-configured for a real send), else the adapter's own
 * sent/failed result — never a silent success. Reused by the dispatch OTP send.
 * Fail-safe: any unexpected error surfaces as a `failed` result, never throws.
 */
export async function sendWhatsAppTemplate(
  workspaceId: string,
  args: { to: string; templateName: string; languageCode?: string; variables: Record<string, string> },
): Promise<{ status: 'sent' | 'failed' | 'provider_not_configured'; messageId?: string; error?: string }> {
  try {
    const rows = await query<{ provider: string; credentials_b64: string | null; config: Record<string, unknown> }>(sql`
      SELECT provider, encode(credentials_encrypted, 'base64') AS credentials_b64, config
      FROM workspace_integrations
      WHERE workspace_id = ${workspaceId}::uuid AND category = 'whatsapp' AND is_active = true
      LIMIT 1
    `);
    const row = rows[0];
    if (!row || row.provider === 'noop') return { status: 'provider_not_configured' };
    const adapter = findAdapter('whatsapp', row.provider) as WhatsAppAdapter | null;
    if (!adapter) return { status: 'provider_not_configured' };
    let credentials: Record<string, string> = {};
    if (row.credentials_b64) {
      try { credentials = (decryptJson(Buffer.from(row.credentials_b64, 'base64')) as Record<string, string>) ?? {}; }
      catch (err) {
        console.error('[notify] whatsapp credential decrypt failed', err);
        return { status: 'failed', error: 'credential_decrypt_failed' };
      }
    }
    return await adapter.sendTemplate({
      to: args.to,
      templateName: args.templateName,
      languageCode: args.languageCode,
      variables: args.variables,
      credentials,
      config: row.config ?? {},
    });
  } catch (err) {
    console.error('[notify] sendWhatsAppTemplate failed', err);
    return { status: 'failed', error: 'send_error' };
  }
}

/** {var} substitution — unknown tokens are left literal so a typo is visible. */
export function substitute(text: string, vars: Record<string, unknown>): string {
  return String(text).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k] ?? '') : `{${k}}`));
}
function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Resolve the email template (subject/body) for an event from workspace settings.
 * Language-aware (Slice 10): a non-'en' `lang` first looks for a translation under
 * templates[event].translations[lang].email, then falls back to the base (en)
 * template. The base shape (043-seeded) is untouched — translations are additive.
 */
function emailTemplateFor(
  settings: Record<string, any> | null | undefined,
  eventType: string,
  lang: string = 'en',
): { subject: string; body: string } | null {
  const node = settings?.notification_policy?.templates?.[eventType];
  if (!node) return null;
  const langTpl = lang && lang !== 'en' ? node.translations?.[lang]?.email : null;
  const t = langTpl && (langTpl.subject || langTpl.body) ? langTpl : node.email;
  if (t && (t.subject || t.body)) return { subject: String(t.subject ?? ''), body: String(t.body ?? '') };
  return null;
}

/** Resolve the WhatsApp template (pre-approved name + variable order) for an event. */
function whatsappTemplateFor(
  settings: Record<string, any> | null | undefined,
  eventType: string,
): { templateName: string; variableOrder: string[] } | null {
  const node = settings?.notification_policy?.templates?.[eventType]?.whatsapp;
  if (!node || !node.template_name) return null;
  return {
    templateName: String(node.template_name),
    variableOrder: Array.isArray(node.variable_order) ? node.variable_order.map(String) : [],
  };
}

/** Is this event flagged marketing (Q6)? Governs unsubscribe-link + opt-out. */
function eventIsMarketing(settings: Record<string, any> | null | undefined, eventType: string): boolean {
  return settings?.notification_policy?.events?.[eventType]?.is_marketing === true;
}

/** Whether customer notification_preferences are enforced (policy scalar, default true). */
function enforceCustomerPreferences(settings: Record<string, any> | null | undefined): boolean {
  return settings?.notification_policy?.enforce_customer_preferences !== false;
}

/** Workspace default language for template routing (default 'en'). */
function workspaceDefaultLanguage(settings: Record<string, any> | null | undefined): string {
  const l = settings?.notification_policy?.default_language;
  return typeof l === 'string' && l ? l : 'en';
}

// ---------------------------------------------------------------------------
// Customer channel preferences (Slice 10) — opt-in per channel + language +
// marketing opt-out. Stored on people.notification_preferences (jsonb) +
// people.preferred_language. Missing keys default to opted-in (transactional
// notifications flow by default; only an explicit false opts out). Never throws.
// ---------------------------------------------------------------------------
type CustomerPrefs = { whatsapp: boolean; email: boolean; sms: boolean; marketing: boolean; language: string };
const DEFAULT_PREFS: CustomerPrefs = { whatsapp: true, email: true, sms: false, marketing: true, language: 'en' };

async function loadCustomerPrefs(personId: string | null): Promise<CustomerPrefs> {
  if (!personId) return { ...DEFAULT_PREFS };
  try {
    const rows = await query<{ prefs: Record<string, unknown> | null; lang: string | null }>(sql`
      SELECT notification_preferences AS prefs, preferred_language AS lang
      FROM people WHERE id = ${personId}::uuid LIMIT 1
    `);
    const r = rows[0];
    if (!r) return { ...DEFAULT_PREFS };
    const p = r.prefs && typeof r.prefs === 'object' ? r.prefs : {};
    return {
      whatsapp: p.whatsapp !== false,
      email: p.email !== false,
      sms: p.sms === true,
      marketing: p.marketing !== false,
      language: r.lang ?? 'en',
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// ---------------------------------------------------------------------------
// Marketing unsubscribe token (Q6) — a stateless HMAC-signed token so a customer
// can opt out of marketing from an email link with no session. Signed with
// INTEGRATION_ENC_KEY (the notification-pipeline secret); absent key → no link
// (fail-open, marketing simply ships without an unsubscribe footer). Verified
// server-side by the public GET /api/notifications/unsubscribe/:token endpoint.
// ---------------------------------------------------------------------------
function unsubscribeSecret(): string | null {
  return process.env.INTEGRATION_ENC_KEY || null;
}

export function makeUnsubscribeToken(workspaceId: string, personId: string): string | null {
  const secret = unsubscribeSecret();
  if (!secret || !personId) return null;
  const payload = Buffer.from(`${workspaceId}:${personId}`).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyUnsubscribeToken(token: string): { workspaceId: string; personId: string } | null {
  const secret = unsubscribeSecret();
  if (!secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { workspaceId: decoded.slice(0, idx), personId: decoded.slice(idx + 1) };
}

function unsubscribeUrl(workspaceId: string, personId: string | null): string | null {
  if (!personId) return null;
  const token = makeUnsubscribeToken(workspaceId, personId);
  if (!token) return null;
  return `${config.appOrigin}/api/notifications/unsubscribe/${token}`;
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
  // Sub-slice 2.2 — internal staff feed.
  'standby_staff_reminder': {
    title: 'Standby {standby_number} expiring soon',
    body: 'Order #{order_number} — the customer hold is about to expire.',
  },
  'quote_accepted_internal': {
    title: 'Quote {quote_number} accepted · Order #{order_number}',
    body: '{customer_name} accepted — {total_amount}. Order confirmed.',
  },
  // Sub-slice 2.3 — substitution + damage internal feed.
  'substitution_pending_approval': {
    title: 'Substitution {substitution_number} needs approval · Order #{order_number}',
    body: '{original_item} → {replacement_item}. Requested by {actor_name}.',
  },
  'damage_incident_reported_internal': {
    title: 'Damage {incident_number} reported · Order #{order_number}',
    body: '{severity} · {incident_type}. Reported by {actor_name}.',
  },
  'damage_incident_pending_approval': {
    title: 'Damage {incident_number} resolution needs approval · Order #{order_number}',
    body: '{resolution_summary} Requested by {actor_name}.',
  },
  // Slice 7 Session 2 — deposit lifecycle (internal staff feed).
  'deposit_released': {
    title: 'Deposit released · Order #{order_number}',
    body: '₹{deposit_amount} refund initiated via {refund_method}. Settlement ~{settlement_eta_days}d.',
  },
  'deposit_forfeited': {
    title: 'Deposit forfeited · Order #{order_number}',
    body: '₹{forfeit_amount} retained ({forfeit_reason_display}). ₹{refund_amount} refund initiated.',
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
export type DeliveryStatus = 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

export type CustomerNotifyResult = {
  mode: string;
  deliveries: Array<{ channel: CustomerChannel; status: DeliveryStatus; reason?: string; provider_ref?: string | null }>;
};

function notificationMode(settings: Record<string, any> | null | undefined, eventType: string): string {
  const m = settings?.notification_policy?.events?.[eventType]?.mode;
  return typeof m === 'string' ? m : 'auto';
}

// Resolved, ready-to-send content per channel. Frozen into the delivery row's
// payload_snapshot so an auto_with_review 'pending' row replays the SAME message
// on approve (snapshot immutability — editing a template later never alters a
// queued notification, same discipline as invoices).
type ChannelRender =
  | { channel: 'email'; subject: string; body: string }
  | { channel: 'whatsapp'; template_name: string; variables: Record<string, string>; language_code?: string };

/** Record one customer delivery row (notification_id NULL). Returns its id. Never throws on the caller. */
async function recordCustomerDelivery(args: {
  workspaceId: string;
  orderId: string;
  personId: string | null;
  channel: CustomerChannel;
  status: DeliveryStatus;
  address: string | null;
  message: string;
  eventType: string;
  language: string;
  isMarketing: boolean;
  render: ChannelRender | null;
  errorMessage?: string | null;
  providerRef?: string | null;
}): Promise<string | null> {
  const deliveredAt = args.status === 'sent' || args.status === 'delivered' || args.status === 'read'
    ? new Date().toISOString() : null;
  const snapshot = {
    order_id: args.orderId,
    event_type: args.eventType,
    message: args.message,
    language: args.language,
    is_marketing: args.isMarketing,
    render: args.render,
  };
  const rows = await query<{ id: string }>(sql`
    INSERT INTO notification_deliveries (
      workspace_id, notification_id, channel, status,
      target_user_id, target_person_id, target_address, payload_snapshot,
      error_message, provider_ref, delivered_at
    ) VALUES (
      ${args.workspaceId}::uuid, NULL, ${args.channel}::text, ${args.status}::text,
      NULL, ${args.personId ?? null}::uuid, ${args.address ?? null}::text,
      ${JSON.stringify(snapshot)}::jsonb,
      ${args.errorMessage ?? null}::text, ${args.providerRef ?? null}::text, ${deliveredAt}::timestamptz
    )
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

// Perform the ACTUAL send for a resolved render on one channel. No DB write —
// the caller records/updates the delivery row. Loads the active adapter itself
// (email/whatsapp). Never throws. Reused by the auto path AND the review-queue
// approve path, so the send logic has exactly one implementation (DRY).
async function performChannelSend(
  workspaceId: string,
  address: string,
  render: ChannelRender,
  ctx: { emailLoaded?: LoadedEmail | null; wsInfo?: WsInfo },
): Promise<{ status: 'sent' | 'failed' | 'skipped'; reason?: string; providerRef?: string | null }> {
  if (render.channel === 'email') {
    const emailLoaded = ctx.emailLoaded ?? (await loadActiveEmailAdapter(workspaceId));
    if (!emailLoaded) return { status: 'skipped', reason: 'no_active_adapter' };
    if (emailLoaded.provider === 'noop') return { status: 'skipped', reason: 'noop_adapter' };
    const wsInfo = ctx.wsInfo ?? (await loadWorkspaceInfo(workspaceId));
    const r = await sendEmail(emailLoaded, { to: address, subject: render.subject, body: render.body, ws: wsInfo });
    return r.status === 'sent'
      ? { status: 'sent', providerRef: r.messageId ?? null }
      : { status: 'failed', reason: r.error ?? 'send_failed' };
  }
  // whatsapp — send a pre-approved template via the active adapter.
  const r = await sendWhatsAppTemplate(workspaceId, {
    to: address,
    templateName: render.template_name,
    languageCode: render.language_code,
    variables: render.variables,
  });
  if (r.status === 'sent') return { status: 'sent', providerRef: r.messageId ?? null };
  if (r.status === 'provider_not_configured') return { status: 'skipped', reason: 'provider_not_configured' };
  return { status: 'failed', reason: r.error ?? 'send_failed' };
}

/**
 * Send a customer-facing notification for a business event, honoring the
 * workspace notification policy AND the customer's channel preferences (Slice 10).
 *
 * Policy modes (settings.notification_policy.events[event].mode):
 *   off              → record 'skipped' (reason 'policy_off'), no send
 *   manual_only      → record 'skipped' (reason 'manual_only'); only Send Update fires it
 *   auto_with_review → record 'pending' (reason 'awaiting_review'); the review queue sends it
 *   auto / missing   → send now (default — backward compatible)
 *
 * A channel is 'skipped' (recorded) when the customer opted out of it, the event
 * is marketing and they opted out of marketing, there's no contact method, or no
 * active adapter. `bypassPolicy` (manual Send Update / OTP-style forced send)
 * overrides BOTH the policy mode and preference enforcement. `whatsapp` supplies
 * an explicit template (OTP / invoice_ready callers); otherwise the WhatsApp
 * template is read from settings. Never throws.
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
  // Merge fields for the email template (falls back to `message`).
  variables?: Record<string, unknown>;
  // Explicit language override (rare); else resolved from the customer's preference.
  language?: string | null;
  // Explicit WhatsApp template (OTP / invoice_ready); else read from settings.
  whatsapp?: { templateName: string; variables: Record<string, string>; languageCode?: string };
  // Redact the stored render's variables (OTP: never persist the plaintext code).
  // The real render is still sent; only the row snapshot is blanked. Safe because
  // sensitive events are always 'auto' (never queued for replay).
  redactRender?: boolean;
}): Promise<CustomerNotifyResult> {
  const result: CustomerNotifyResult = { mode: 'auto', deliveries: [] };
  try {
    const settings = args.settings ?? (await loadWorkspaceSettingsSafe(args.workspaceId));
    const mode = args.bypassPolicy ? 'manual' : notificationMode(settings, args.eventType);
    result.mode = mode;

    const [emailLoaded, wsInfo, prefs] = await Promise.all([
      loadActiveEmailAdapter(args.workspaceId),
      loadWorkspaceInfo(args.workspaceId),
      loadCustomerPrefs(args.personId),
    ]);
    const enforce = enforceCustomerPreferences(settings);
    const lang = args.language ?? prefs.language ?? workspaceDefaultLanguage(settings);
    const isMarketing = eventIsMarketing(settings, args.eventType);
    const vars: Record<string, unknown> = { workspace_name: wsInfo.name, ...(args.variables ?? {}) };
    const tpl = emailTemplateFor(settings, args.eventType, lang);
    const waTpl = whatsappTemplateFor(settings, args.eventType);

    for (const channel of args.channels) {
      const address = channel === 'whatsapp' ? args.contact.phone ?? null : args.contact.email ?? null;
      const optedIn = channel === 'whatsapp' ? prefs.whatsapp : prefs.email;

      // Build the resolved, replayable render for this channel.
      let render: ChannelRender | null = null;
      if (channel === 'email') {
        let subject = tpl ? substitute(tpl.subject, vars) : `Update on your order #${vars.order_number ?? ''}`;
        let body = tpl ? substitute(tpl.body, vars) : args.message;
        if (isMarketing) {
          const url = unsubscribeUrl(args.workspaceId, args.personId);
          if (url) body = `${body}\n\n---\nTo stop receiving marketing messages, unsubscribe: ${url}`;
        }
        render = { channel: 'email', subject, body };
      } else if (args.whatsapp) {
        render = { channel: 'whatsapp', template_name: args.whatsapp.templateName, variables: args.whatsapp.variables, language_code: args.whatsapp.languageCode ?? lang };
      } else if (waTpl) {
        const variables: Record<string, string> = {};
        waTpl.variableOrder.forEach((field, i) => { variables[String(i + 1)] = String(vars[field] ?? ''); });
        render = { channel: 'whatsapp', template_name: waTpl.templateName, variables, language_code: lang };
      }

      let status: DeliveryStatus = 'skipped';
      let reason: string | undefined;
      let providerRef: string | null = null;

      // ---- gates (skipped short-circuits, no send) ----
      if (!args.bypassPolicy && mode === 'off') { status = 'skipped'; reason = 'policy_off'; }
      else if (!args.bypassPolicy && mode === 'manual_only') { status = 'skipped'; reason = 'manual_only'; }
      else if (!args.bypassPolicy && enforce && !optedIn) { status = 'skipped'; reason = 'customer_opted_out'; }
      else if (!args.bypassPolicy && enforce && isMarketing && !prefs.marketing) { status = 'skipped'; reason = 'marketing_opted_out'; }
      else if (!address) { status = 'skipped'; reason = 'no_contact_method'; }
      else if (channel === 'whatsapp' && !render) { status = 'skipped'; reason = 'no_whatsapp_template'; }
      else if (!args.bypassPolicy && mode === 'auto_with_review') { status = 'pending'; reason = 'awaiting_review'; }
      else {
        // ---- send now ----
        const out = await performChannelSend(args.workspaceId, address, render!, { emailLoaded, wsInfo });
        status = out.status;
        reason = out.reason;
        providerRef = out.providerRef ?? null;
      }

      // Redact sensitive variables (OTP code) from the STORED render — the real
      // render was already sent above. Keeps the channel/template for display.
      const storedRender: ChannelRender | null =
        args.redactRender && render && render.channel === 'whatsapp'
          ? { channel: 'whatsapp', template_name: render.template_name, variables: {}, language_code: render.language_code }
          : render;

      await recordCustomerDelivery({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: args.personId,
        channel, status, address, message: args.message, eventType: args.eventType,
        language: lang, isMarketing, render: storedRender,
        errorMessage: reason ?? null, providerRef,
      });
      result.deliveries.push({ channel, status, reason, provider_ref: providerRef });
    }
  } catch (err) {
    console.error('emitCustomerNotification failed:', err, args.eventType);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Review queue (Q5) — an auto_with_review event lands as a 'pending' delivery
// row. A reviewer approves (send the frozen render, transition the SAME row to
// sent/failed) or rejects (mark skipped). The send reuses performChannelSend, so
// the approve path and the auto path share one send implementation.
// ---------------------------------------------------------------------------

/** Approve a pending review-queue delivery: send its frozen render, update the row. */
export async function sendPendingDelivery(
  workspaceId: string,
  deliveryId: string,
): Promise<{ ok: boolean; status?: DeliveryStatus; reason?: string; error?: string }> {
  try {
    const rows = await query<{
      channel: CustomerChannel; status: string; target_address: string | null; payload_snapshot: any;
    }>(sql`
      SELECT channel, status, target_address, payload_snapshot
      FROM notification_deliveries
      WHERE id = ${deliveryId}::uuid AND workspace_id = ${workspaceId}::uuid AND notification_id IS NULL
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'pending') return { ok: false, error: 'not_pending' };
    const render = row.payload_snapshot?.render as ChannelRender | null;
    const address = row.target_address;
    if (!render || !address) {
      await sql`UPDATE notification_deliveries SET status = 'failed', error_message = 'missing_render_or_address'
                WHERE id = ${deliveryId}::uuid AND workspace_id = ${workspaceId}::uuid`;
      return { ok: false, error: 'missing_render_or_address' };
    }
    const out = await performChannelSend(workspaceId, address, render, {});
    const deliveredAt = out.status === 'sent' ? new Date().toISOString() : null;
    await sql`
      UPDATE notification_deliveries
      SET status = ${out.status}::text, error_message = ${out.reason ?? null}::text,
          provider_ref = ${out.providerRef ?? null}::text, delivered_at = ${deliveredAt}::timestamptz
      WHERE id = ${deliveryId}::uuid AND workspace_id = ${workspaceId}::uuid
    `;
    return { ok: true, status: out.status, reason: out.reason };
  } catch (err) {
    console.error('sendPendingDelivery failed:', err, deliveryId);
    return { ok: false, error: 'send_error' };
  }
}

/** Reject a pending review-queue delivery: mark it skipped (reason 'rejected_by_reviewer'). */
export async function rejectPendingDelivery(
  workspaceId: string,
  deliveryId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const rows = await query<{ id: string }>(sql`
      UPDATE notification_deliveries
      SET status = 'skipped', error_message = 'rejected_by_reviewer'
      WHERE id = ${deliveryId}::uuid AND workspace_id = ${workspaceId}::uuid
        AND notification_id IS NULL AND status = 'pending'
      RETURNING id
    `);
    if (!rows[0]) return { ok: false, error: 'not_pending' };
    return { ok: true };
  } catch (err) {
    console.error('rejectPendingDelivery failed:', err, deliveryId);
    return { ok: false, error: 'reject_error' };
  }
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
