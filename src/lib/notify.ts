import { sql, query } from '../db.js';

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
};

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

    // Active members except the actor.
    const recipients = await query<{ user_id: string }>(sql`
      SELECT m.user_id
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${args.workspaceId}::uuid
        AND m.status = 'active'
        AND u.deleted_at IS NULL
        AND (${args.actorUserId ?? null}::uuid IS NULL OR m.user_id != ${args.actorUserId ?? null}::uuid)
    `);

    // Which external channels have an active adapter this workspace? Loaded once
    // per emit (not per recipient). Sub-turn 6a only *records* the delivery
    // intent — it does not actually send. A configured noop adapter records
    // 'skipped'; a real (future) adapter records 'pending' for a sender to pick
    // up. No active adapter → no external row at all.
    const [waIntegration, emailIntegration] = await Promise.all([
      loadActiveIntegration(args.workspaceId, 'whatsapp'),
      loadActiveIntegration(args.workspaceId, 'email'),
    ]);
    const externalChannels: Array<{ channel: 'whatsapp' | 'email'; status: 'pending' | 'skipped' }> = [];
    if (waIntegration) {
      externalChannels.push({ channel: 'whatsapp', status: waIntegration.provider === 'noop' ? 'skipped' : 'pending' });
    }
    if (emailIntegration) {
      externalChannels.push({ channel: 'email', status: emailIntegration.provider === 'noop' ? 'skipped' : 'pending' });
    }

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

      // External channels: record the delivery intent for each active adapter.
      // 6a wires the pipe only — nothing is actually sent here.
      for (const ext of externalChannels) {
        await sql`
          INSERT INTO notification_deliveries (
            workspace_id, notification_id, channel, status, target_user_id, payload_snapshot
          ) VALUES (
            ${args.workspaceId}::uuid,
            ${notificationId}::uuid,
            ${ext.channel}::text,
            ${ext.status}::text,
            ${r.user_id}::uuid,
            ${JSON.stringify({ title, body, link_url: args.linkUrl ?? null })}::jsonb
          )
        `;
      }
    }
  } catch (err) {
    console.error('emitNotification failed:', err, args.eventType);
  }
}
