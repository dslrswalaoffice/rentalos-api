import { sql } from '../db.js';

/**
 * Event-type catalog. Adding a new event? Add it here so we get autocompletion
 * and can grep for all emission sites.
 */
export type AuditEventType =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.login.rate_limited'
  | 'auth.logout'
  | 'auth.session.expired'
  | 'auth.password.reset_requested'
  | 'auth.password.reset_completed'
  | 'auth.password.reset_failed'
  | 'auth.password.reset_rate_limited'
  | 'inventory.product.created'
  | 'inventory.product.updated'
  | 'inventory.product.archived'
  | 'inventory.product.restored'
  | 'inventory.asset.created'
  | 'inventory.asset.updated'
  | 'inventory.kit.component_added'
  | 'inventory.kit.component_updated'
  | 'inventory.kit.component_removed'
  | 'inventory.product.image_uploaded'
  | 'inventory.product.image_removed'
  | 'admin.migrate.success'
  | 'admin.migrate.failure'
  | 'admin.seed.success'
  | 'admin.seed.failure'
  | 'admin.access.invalid_token'
  | 'admin.user.created'
  | 'admin.user.create_failed'
  | 'people.person.created'
  | 'people.person.updated'
  | 'people.person.archived'
  | 'people.person.restored'
  | 'people.role.added'
  | 'people.role.removed'
  | 'people.tier.changed'
  | 'people.trust_score.changed'
  | 'people.communication.logged'
  | 'people.communication.deleted'
  | 'orders.order.created'
  | 'orders.order.updated'
  | 'orders.order.deleted'
  | 'orders.item.added'
  | 'orders.item.updated'
  | 'orders.item.removed'
  | 'orders.item.price_overridden'
  | 'orders.item.price_reverted'
  | 'orders.status.changed'
  | 'orders.status.forced'
  | 'orders.extended'
  | 'orders.pricing.recomputed'
  | 'orders.payment.recorded'
  | 'orders.payment.refunded'
  | 'orders.payment.deleted'
  | 'orders.deposit_status.changed'
  | 'payments.deposit_recorded'
  | 'payments.deposit_refunded'
  | 'payments.deposit_forfeited'
  | 'orders.item.status.changed'
  | 'orders.item.status.forced'
  | 'orders.invoice.generated'
  | 'orders.invoice.status.changed'
  | 'orders.invoice.status.forced'
  | 'orders.dispatch.batch'
  | 'orders.return.batch'
  | 'orders.contract.signed'
  | 'orders.contract.unsigned_generated'
  | 'workspace.settings.updated'
  | 'integration.configured'
  | 'integration.activated'
  | 'integration.deactivated'
  | 'integration.removed'
  | 'integration.test_run';

export type AuditEventInput = {
  workspaceId?: string | null;
  actorUserId?: string | null;
  eventType: AuditEventType;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Append an audit event. Should NEVER throw — a failure here must not break
 * a business action. We log to console and swallow. If we ever need to alert on
 * this, replace the catch with a Sentry ping.
 */
export async function audit(evt: AuditEventInput): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_events (
        workspace_id, actor_user_id, event_type,
        target_type, target_id, payload, ip_address, user_agent
      ) VALUES (
        ${evt.workspaceId ?? null},
        ${evt.actorUserId ?? null},
        ${evt.eventType},
        ${evt.targetType ?? null},
        ${evt.targetId ?? null},
        ${JSON.stringify(evt.payload ?? {})}::jsonb,
        ${evt.ipAddress ?? null},
        ${evt.userAgent ?? null}
      )
    `;
  } catch (err) {
    // Never let audit failures break the business action.
    console.error('[audit] failed to write event', evt.eventType, err);
  }
}
