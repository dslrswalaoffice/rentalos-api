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
  | 'inventory.asset.relocated'
  | 'locations.created'
  | 'locations.updated'
  | 'locations.deleted'
  | 'downtimes.created'
  | 'downtimes.updated'
  | 'downtimes.deleted'
  | 'tags.created'
  | 'tags.updated'
  | 'tags.deleted'
  | 'coupons.created'
  | 'coupons.updated'
  | 'coupons.deactivated'
  | 'coupons.applied'
  | 'coupons.removed'
  | 'recommendations.created'
  | 'recommendations.removed'
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
  | 'people.kyc.document_submitted'
  | 'people.kyc.document_verified'
  | 'people.kyc.document_rejected'
  | 'people.kyc.status_changed'
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
  | 'orders.extension.requested'
  | 'orders.cancelled'
  | 'orders.cancellation.requested'
  | 'orders.comm.sent'
  | 'approvals.approved'
  | 'approvals.rejected'
  | 'approvals.withdrawn'
  | 'standbys.created'
  | 'standbys.released'
  | 'standbys.activated'
  | 'standbys.converted'
  | 'standbys.extended'
  | 'standbys.expired'
  | 'quotes.created'
  | 'quotes.sent'
  | 'quotes.accepted'
  | 'quotes.withdrawn'
  | 'quotes.rejected'
  | 'quotes.expired'
  // Sub-slice 2.3 — substitutions + damage incidents.
  | 'substitutions.created'
  | 'substitutions.executed'
  | 'substitutions.reverted'
  | 'substitutions.approved'
  | 'substitutions.rejected'
  | 'damage_incidents.created'
  | 'damage_incidents.save_the_shoot'
  | 'damage_incidents.financial_resolution'
  | 'damage_incidents.approved'
  | 'damage_incidents.rejected'
  | 'damage_incidents.closed'
  | 'orders.pricing.recomputed'
  | 'orders.payment.recorded'
  | 'orders.payment.refunded'
  | 'orders.payment.deleted'
  | 'orders.deposit_status.changed'
  | 'payments.deposit_recorded'
  | 'payments.deposit_refunded'
  | 'payments.deposit_forfeited'
  | 'deposits.auto_release_initiated'
  | 'deposits.release_completed'
  | 'orders.item.status.changed'
  | 'orders.item.status.forced'
  | 'orders.invoice.generated'
  | 'orders.invoice.status.changed'
  | 'orders.invoice.status.forced'
  | 'orders.invoice.auto_marked_paid'
  | 'orders.invoice.auto_reopened'
  | 'dispatches.items_recorded'
  | 'dispatches.serial_verified'
  | 'dispatches.condition_recorded'
  | 'orders.dispatch.batch'
  | 'orders.dispatch.reverted'
  // Slice 4 — structured dispatch/handover flow (dispatches table).
  | 'dispatches.created'
  | 'dispatches.recipient_recorded'
  | 'dispatches.photo_captured'
  | 'dispatches.otp_sent'
  | 'dispatches.otp_verified'
  | 'dispatches.otp_skipped'
  | 'dispatches.signature_captured'
  | 'dispatches.completed'
  | 'returns.created'
  | 'returns.recipient_recorded'
  | 'returns.items_recorded'
  | 'returns.serial_verified'
  | 'returns.condition_recorded'
  | 'returns.accessories_recorded'
  | 'returns.photo_captured'
  | 'returns.otp_sent'
  | 'returns.otp_verified'
  | 'returns.otp_skipped'
  | 'returns.signature_captured'
  | 'returns.completed'
  | 'inspections.scheduled'
  | 'inspections.started'
  | 'inspections.completed'
  | 'orders.return.batch'
  | 'orders.contract.signed'
  | 'orders.contract.unsigned_generated'
  | 'invoices.reminder.sent'
  | 'invoices.reminder.failed'
  | 'invoices.reminder.skipped'
  | 'custom_fields.definition_created'
  | 'custom_fields.definition_updated'
  | 'custom_fields.definition_removed'
  | 'custom_fields.values_updated'
  | 'workspace.settings.updated'
  | 'integration.configured'
  | 'integration.activated'
  | 'integration.deactivated'
  | 'integration.removed'
  | 'integration.test_run'
  | 'invitation.created'
  | 'invitation.revoked'
  | 'invitation.accepted'
  | 'team.member.permission_changed'
  | 'team.member.status_changed'
  | 'team.member.role_changed'
  | 'team.member.made_owner'
  | 'pricing.structure.created'
  | 'pricing.structure.updated'
  | 'pricing.structure.deleted'
  | 'pricing.ruleset.created'
  | 'pricing.ruleset.updated'
  | 'pricing.ruleset.deleted'
  | 'inventory.stock.updated';

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
