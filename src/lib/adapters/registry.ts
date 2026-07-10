import type { AdapterMetadata } from './types.js';
import { noopPaymentAdapter, noopWhatsAppAdapter, noopEmailAdapter } from './noop.js';
import { smtpEmailAdapter } from './smtp.js';
import { watiWhatsAppAdapter } from './wati.js';

// ============================================================================
// src/lib/adapters/registry.ts  (Sub-turn 6a)
// ----------------------------------------------------------------------------
// Hardcoded registry of every supported adapter (implemented or not). The UI
// lists all; only `implemented: true` ones are configurable/activatable.
// Adding a provider = add metadata here (+ a concrete adapter in
// IMPLEMENTED_ADAPTERS when it's built).
// ============================================================================

export const ADAPTER_METADATA: AdapterMetadata[] = [
  // ---- Payment ----
  {
    provider: 'noop', displayName: 'Noop (testing)', category: 'payment',
    description: 'Test adapter. Logs payment intents. No real charges.',
    credentialFields: [], configFields: [], supportsTest: false, implemented: true,
  },
  {
    provider: 'cashfree', displayName: 'Cashfree Payments', category: 'payment',
    description: 'UPI, Cards, Netbanking, Wallets. Indian market focus.',
    helpUrl: 'https://docs.cashfree.com',
    credentialFields: [
      { key: 'app_id', label: 'App ID', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', required: true },
    ],
    configFields: [
      { key: 'environment', label: 'Environment', type: 'select', required: true, options: ['sandbox', 'production'] },
    ],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'razorpay', displayName: 'Razorpay', category: 'payment',
    description: 'UPI, Cards, Netbanking. Full-featured Indian payment gateway.',
    helpUrl: 'https://razorpay.com/docs',
    credentialFields: [
      { key: 'key_id', label: 'Key ID', type: 'text', required: true },
      { key: 'key_secret', label: 'Key Secret', type: 'password', required: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', required: true },
    ],
    configFields: [
      { key: 'environment', label: 'Environment', type: 'select', required: true, options: ['test', 'live'] },
    ],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'stripe', displayName: 'Stripe', category: 'payment',
    description: 'Cards + local payment methods. Best for international markets.',
    helpUrl: 'https://stripe.com/docs',
    credentialFields: [
      { key: 'publishable_key', label: 'Publishable Key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret Key', type: 'password', required: true },
      { key: 'webhook_secret', label: 'Webhook Signing Secret', type: 'password', required: true },
    ],
    configFields: [],
    supportsTest: true, implemented: false,
  },

  // ---- WhatsApp ----
  {
    provider: 'noop', displayName: 'Noop (testing)', category: 'whatsapp',
    description: 'Test adapter. Logs messages. No real sends.',
    credentialFields: [], configFields: [], supportsTest: false, implemented: true,
  },
  {
    provider: 'wati', displayName: 'WATI', category: 'whatsapp',
    description: 'Popular WhatsApp Business API provider for SMBs in India.',
    helpUrl: 'https://docs.wati.io',
    credentialFields: [
      { key: 'api_key', label: 'API Access Token', type: 'password', required: true },
    ],
    configFields: [
      { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://live-server-XXXXX.wati.io' },
      { key: 'phone_number_id', label: 'WhatsApp Phone Number ID', type: 'text', required: false },
    ],
    supportsTest: false, implemented: true,
  },
  {
    provider: 'aisensy', displayName: 'AiSensy', category: 'whatsapp',
    description: 'WhatsApp Business API with template automation.',
    helpUrl: 'https://docs.aisensy.com',
    credentialFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
    configFields: [
      { key: 'campaign_id', label: 'Campaign ID', type: 'text', required: false },
    ],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'interakt', displayName: 'Interakt', category: 'whatsapp',
    description: 'WhatsApp Business Automation platform.',
    helpUrl: 'https://interakt.ai',
    credentialFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
    configFields: [],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'twilio_whatsapp', displayName: 'Twilio WhatsApp', category: 'whatsapp',
    description: 'Twilio-hosted WhatsApp Business API.',
    helpUrl: 'https://www.twilio.com/whatsapp',
    credentialFields: [
      { key: 'account_sid', label: 'Account SID', type: 'text', required: true },
      { key: 'auth_token', label: 'Auth Token', type: 'password', required: true },
    ],
    configFields: [
      { key: 'from_number', label: 'From WhatsApp Number', type: 'text', required: true, placeholder: 'whatsapp:+14155238886' },
    ],
    supportsTest: true, implemented: false,
  },

  // ---- Email ----
  {
    provider: 'noop', displayName: 'Noop (testing)', category: 'email',
    description: 'Test adapter. Logs emails. No real sends.',
    credentialFields: [], configFields: [], supportsTest: false, implemented: true,
  },
  {
    provider: 'smtp', displayName: 'SMTP', category: 'email',
    description: 'Send via any SMTP server (Gmail, custom, etc.).',
    credentialFields: [
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password / App Password', type: 'password', required: true },
    ],
    configFields: [
      { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'smtp.gmail.com' },
      { key: 'port', label: 'Port', type: 'text', required: true, placeholder: '587' },
      { key: 'use_tls', label: 'Use TLS', type: 'select', required: true, options: ['true', 'false'] },
      { key: 'from_email', label: 'From Email', type: 'email', required: true },
      { key: 'from_name', label: 'From Name', type: 'text', required: false },
    ],
    supportsTest: false, implemented: true,
  },
  {
    provider: 'sendgrid', displayName: 'SendGrid', category: 'email',
    description: 'Transactional email provider by Twilio.',
    helpUrl: 'https://sendgrid.com/docs',
    credentialFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
    configFields: [
      { key: 'from_email', label: 'Verified Sender Email', type: 'email', required: true },
      { key: 'from_name', label: 'Sender Name', type: 'text', required: false },
    ],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'mailgun', displayName: 'Mailgun', category: 'email',
    description: 'Transactional email with EU + US regions.',
    helpUrl: 'https://documentation.mailgun.com',
    credentialFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
    configFields: [
      { key: 'domain', label: 'Sending Domain', type: 'text', required: true },
      { key: 'region', label: 'Region', type: 'select', required: true, options: ['us', 'eu'] },
      { key: 'from_email', label: 'From Email', type: 'email', required: true },
      { key: 'from_name', label: 'From Name', type: 'text', required: false },
    ],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'postmark', displayName: 'Postmark', category: 'email',
    description: 'High-deliverability transactional email.',
    helpUrl: 'https://postmarkapp.com/developer',
    credentialFields: [
      { key: 'server_token', label: 'Server Token', type: 'password', required: true },
    ],
    configFields: [
      { key: 'from_email', label: 'From Email', type: 'email', required: true },
      { key: 'from_name', label: 'From Name', type: 'text', required: false },
    ],
    supportsTest: true, implemented: false,
  },
  {
    provider: 'aws_ses', displayName: 'AWS SES', category: 'email',
    description: 'Amazon Simple Email Service.',
    helpUrl: 'https://aws.amazon.com/ses/',
    credentialFields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
    ],
    configFields: [
      { key: 'region', label: 'AWS Region', type: 'text', required: true, placeholder: 'ap-south-1' },
      { key: 'from_email', label: 'From Email', type: 'email', required: true },
      { key: 'from_name', label: 'From Name', type: 'text', required: false },
    ],
    supportsTest: true, implemented: false,
  },
];

// Concrete adapter instances (only implemented ones).
export const IMPLEMENTED_ADAPTERS: Record<string, Record<string, unknown>> = {
  payment: { noop: noopPaymentAdapter },
  whatsapp: { noop: noopWhatsAppAdapter, wati: watiWhatsAppAdapter },
  email: { noop: noopEmailAdapter, smtp: smtpEmailAdapter },
};

export function findAdapter(category: string, provider: string): any {
  return IMPLEMENTED_ADAPTERS[category]?.[provider] ?? null;
}

export function findMetadata(category: string, provider: string): AdapterMetadata | null {
  return ADAPTER_METADATA.find((m) => m.category === category && m.provider === provider) ?? null;
}

export function listMetadata(category?: string): AdapterMetadata[] {
  if (category) return ADAPTER_METADATA.filter((m) => m.category === category);
  return ADAPTER_METADATA;
}
