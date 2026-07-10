import type { PaymentAdapter, WhatsAppAdapter, EmailAdapter } from './types.js';

// ============================================================================
// src/lib/adapters/noop.ts  (Sub-turn 6a)
// ----------------------------------------------------------------------------
// No-op adapters: log + return success. Used to verify the whole pipeline
// (configure → activate → deliver) end-to-end before any real adapter exists.
// ============================================================================

export const noopPaymentAdapter: PaymentAdapter = {
  metadata: {
    provider: 'noop', displayName: 'Noop', category: 'payment', description: '',
    credentialFields: [], configFields: [], supportsTest: false, implemented: true,
  },
  async createPaymentLink(args) {
    console.log('[noop payment] createPaymentLink', args.orderNumber, args.amountPaise);
    return { url: `https://example.com/noop-payment/${args.orderId}`, reference: `noop-${Date.now()}` };
  },
  async handleWebhook(args) {
    console.log('[noop payment] handleWebhook', args.body);
    return { status: 'success', reference: 'noop', amountPaise: 0 };
  },
  async refund(args) {
    console.log('[noop payment] refund', args.paymentReference, args.amountPaise);
    return { status: 'success', refundReference: `noop-refund-${Date.now()}` };
  },
};

export const noopWhatsAppAdapter: WhatsAppAdapter = {
  metadata: {
    provider: 'noop', displayName: 'Noop', category: 'whatsapp', description: '',
    credentialFields: [], configFields: [], supportsTest: false, implemented: true,
  },
  async sendTemplate(args) {
    console.log('[noop whatsapp] sendTemplate', args.to, args.templateName, args.variables);
    return { status: 'sent', messageId: `noop-wa-${Date.now()}` };
  },
  async sendFreeform(args) {
    console.log('[noop whatsapp] sendFreeform', args.to, args.body.slice(0, 60));
    return { status: 'sent', messageId: `noop-wa-${Date.now()}` };
  },
};

export const noopEmailAdapter: EmailAdapter = {
  metadata: {
    provider: 'noop', displayName: 'Noop', category: 'email', description: '',
    credentialFields: [], configFields: [], supportsTest: false, implemented: true,
  },
  async send(args) {
    console.log('[noop email] send', args.to, args.subject);
    return { status: 'sent', messageId: `noop-email-${Date.now()}` };
  },
};
