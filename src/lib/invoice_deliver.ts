// ============================================================================
// src/lib/invoice_deliver.ts (Slice 6 Session 1) — invoice delivery to customer.
// ----------------------------------------------------------------------------
// REUSES the existing notification pipeline (src/lib/notify.ts) — WhatsApp via
// sendWhatsAppTemplate, email via emitCustomerNotification (SMTP). No new adapter
// interface. Every attempt is logged to invoice_deliveries (channel + status +
// provider_ref/failure_reason). Fail-open per channel: a channel with no active
// adapter or no contact records status='failed', reason='provider_not_configured'
// and the next channel is still tried. Q8: WhatsApp first, email fallback.
// ============================================================================

import { sql, query } from '../db.js';
import { emitCustomerNotification, sendWhatsAppTemplate } from './notify.js';

export type DeliveryChannel = 'whatsapp' | 'email';
export type DeliveryResult = {
  invoice_id: string;
  channels: Array<{ channel: DeliveryChannel; status: 'sent' | 'failed'; recipient: string | null; reason?: string; provider_ref?: string | null }>;
  any_sent: boolean;
};

async function recordDelivery(args: { workspaceId: string; invoiceId: string; channel: string; recipient: string; status: 'queued' | 'sent' | 'delivered' | 'failed'; providerRef?: string | null; failureReason?: string | null }) {
  await sql`
    INSERT INTO invoice_deliveries (workspace_id, invoice_id, channel, recipient, status, provider_ref, failure_reason, sent_at)
    VALUES (${args.workspaceId}::uuid, ${args.invoiceId}::uuid, ${args.channel}::text, ${args.recipient}::text, ${args.status}::text,
            ${args.providerRef ?? null}::text, ${args.failureReason ?? null}::text, ${args.status === 'sent' ? new Date().toISOString() : null}::timestamptz)
  `;
}

/**
 * Deliver an already-generated invoice PDF to the customer over the requested
 * channels. Never throws — a delivery failure must not break the caller (issue /
 * auto-send). `recipientOverride` targets a specific address (else derived from
 * the invoice snapshot / customer).
 */
export async function deliverInvoice(
  workspaceId: string,
  invoiceId: string,
  opts: { channels?: DeliveryChannel[]; recipientOverride?: string | null; actorUserId?: string | null } = {},
): Promise<DeliveryResult> {
  const result: DeliveryResult = { invoice_id: invoiceId, channels: [], any_sent: false };
  try {
    const rows = await query<{ invoice_number: string; pdf_url: string | null; order_id: string; customer_id: string | null; snapshot: any }>(sql`
      SELECT invoice_number, pdf_url, order_id, customer_id, snapshot FROM invoices
      WHERE id = ${invoiceId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
    `);
    const inv = rows[0];
    if (!inv) { result.channels.push({ channel: 'email', status: 'failed', recipient: null, reason: 'invoice_not_found' }); return result; }

    const snapCust = inv.snapshot?.customer ?? {};
    const phone = opts.recipientOverride ?? snapCust.phone ?? null;
    const email = opts.recipientOverride ?? snapCust.email ?? null;
    const channels = opts.channels && opts.channels.length ? opts.channels : (['whatsapp', 'email'] as DeliveryChannel[]);
    const pdfUrl = inv.pdf_url ?? '';

    for (const channel of channels) {
      if (channel === 'whatsapp') {
        const to = opts.recipientOverride ?? phone;
        if (!to) { await recordDelivery({ workspaceId, invoiceId, channel, recipient: '', status: 'failed', failureReason: 'no_contact_method' }); result.channels.push({ channel, status: 'failed', recipient: null, reason: 'no_contact_method' }); continue; }
        const send = await sendWhatsAppTemplate(workspaceId, { to, templateName: 'invoice_ready', variables: { '1': inv.invoice_number, '2': pdfUrl } });
        if (send.status === 'sent') { await recordDelivery({ workspaceId, invoiceId, channel, recipient: to, status: 'sent', providerRef: send.messageId ?? null }); result.channels.push({ channel, status: 'sent', recipient: to, provider_ref: send.messageId ?? null }); result.any_sent = true; }
        else { const reason = send.status === 'provider_not_configured' ? 'provider_not_configured' : (send.error ?? 'send_failed'); await recordDelivery({ workspaceId, invoiceId, channel, recipient: to, status: 'failed', failureReason: reason }); result.channels.push({ channel, status: 'failed', recipient: to, reason }); }
      } else {
        const to = opts.recipientOverride ?? email;
        if (!to) { await recordDelivery({ workspaceId, invoiceId, channel, recipient: '', status: 'failed', failureReason: 'no_contact_method' }); result.channels.push({ channel, status: 'failed', recipient: null, reason: 'no_contact_method' }); continue; }
        // Reuse the SMTP send in emitCustomerNotification (email channel only).
        const notify = await emitCustomerNotification({
          workspaceId, orderId: inv.order_id, personId: inv.customer_id, eventType: 'invoice.ready',
          message: `Your invoice ${inv.invoice_number} is ready. Download: ${pdfUrl}`,
          channels: ['email'], contact: { email: to }, bypassPolicy: true,
          variables: { invoice_number: inv.invoice_number, pdf_url: pdfUrl },
        });
        const d = notify.deliveries.find((x) => x.channel === 'email');
        if (d?.status === 'sent') { await recordDelivery({ workspaceId, invoiceId, channel, recipient: to, status: 'sent', providerRef: d.provider_ref ?? null }); result.channels.push({ channel, status: 'sent', recipient: to, provider_ref: d.provider_ref ?? null }); result.any_sent = true; }
        else { const reason = d?.reason === 'no_active_adapter' || d?.reason === 'noop_adapter' ? 'provider_not_configured' : (d?.reason ?? 'send_failed'); await recordDelivery({ workspaceId, invoiceId, channel, recipient: to, status: 'failed', failureReason: reason }); result.channels.push({ channel, status: 'failed', recipient: to, reason }); }
      }
    }
  } catch (err) {
    console.error('[invoice_deliver] failed', err);
  }
  return result;
}
