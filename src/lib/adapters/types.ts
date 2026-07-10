// ============================================================================
// src/lib/adapters/types.ts  (Sub-turn 6a)
// ----------------------------------------------------------------------------
// Interfaces every third-party adapter implements. Concrete adapters (Cashfree,
// WATI, SendGrid, …) land in future sub-turns; 6a ships only the noop.
// ============================================================================

export type AdapterCategory = 'payment' | 'whatsapp' | 'email';

export interface CredentialField {
  key: string; // 'api_key', 'sender_email', etc.
  label: string; // "API Key"
  type: 'text' | 'password' | 'email' | 'url' | 'select';
  required: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[]; // for select type
}

export interface AdapterMetadata {
  provider: string; // 'cashfree'
  displayName: string; // 'Cashfree Payments'
  category: AdapterCategory;
  description: string; // short marketing line
  helpUrl?: string; // link to docs
  icon?: string; // URL or emoji
  credentialFields: CredentialField[];
  configFields: CredentialField[]; // non-secret config
  supportsTest: boolean; // whether adapter has a testConnection method
  implemented: boolean; // false = "Coming soon" placeholder
}

export interface PaymentAdapter {
  metadata: AdapterMetadata;
  createPaymentLink(args: {
    orderId: string;
    orderNumber: number;
    customerName: string;
    customerPhone?: string;
    customerEmail?: string;
    amountPaise: number;
    returnUrl: string;
    credentials: Record<string, string>;
    config: Record<string, unknown>;
  }): Promise<{ url: string; reference: string }>;

  handleWebhook(args: {
    body: unknown;
    headers: Record<string, string>;
    credentials: Record<string, string>;
  }): Promise<{
    status: 'success' | 'failed' | 'pending' | 'unknown';
    reference: string;
    amountPaise: number;
    orderReference?: string;
  }>;

  refund?(args: {
    paymentReference: string;
    amountPaise: number;
    credentials: Record<string, string>;
  }): Promise<{ status: 'success' | 'failed' | 'pending'; refundReference?: string }>;

  testConnection?(args: { credentials: Record<string, string> }): Promise<{ ok: boolean; message: string }>;
}

export interface WhatsAppAdapter {
  metadata: AdapterMetadata;
  sendTemplate(args: {
    to: string; // E.164 phone
    templateName: string;
    languageCode?: string;
    variables: Record<string, string>;
    credentials: Record<string, string>;
    config: Record<string, unknown>;
  }): Promise<{ status: 'sent' | 'failed'; messageId?: string; error?: string }>;

  sendFreeform?(args: {
    to: string;
    body: string;
    credentials: Record<string, string>;
    config: Record<string, unknown>;
  }): Promise<{ status: 'sent' | 'failed'; messageId?: string; error?: string }>;

  testConnection?(args: { credentials: Record<string, string> }): Promise<{ ok: boolean; message: string }>;
}

export interface EmailAdapter {
  metadata: AdapterMetadata;
  send(args: {
    to: string;
    from: string;
    fromName?: string;
    subject: string;
    html: string;
    text?: string;
    credentials: Record<string, string>;
    config: Record<string, unknown>;
  }): Promise<{ status: 'sent' | 'failed'; messageId?: string; error?: string }>;

  testConnection?(args: { credentials: Record<string, string> }): Promise<{ ok: boolean; message: string }>;
}

export type AnyAdapter = PaymentAdapter | WhatsAppAdapter | EmailAdapter;
