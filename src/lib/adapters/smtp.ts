import nodemailer from 'nodemailer';
import type { EmailAdapter, AdapterMetadata } from './types.js';

// ============================================================================
// src/lib/adapters/smtp.ts  (Sub-turn 6f)
// ----------------------------------------------------------------------------
// Concrete email adapter over nodemailer. Works with any SMTP server (Gmail
// app-password, custom relay, etc.). Credentials/config come from the active
// `email` workspace_integration.
// ============================================================================

const metadata: AdapterMetadata = {
  provider: 'smtp',
  displayName: 'SMTP',
  category: 'email',
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
  supportsTest: false,
  implemented: true,
};

export const smtpEmailAdapter: EmailAdapter = {
  metadata,
  async send(args) {
    try {
      const port = Number(args.config.port) || 587;
      const transporter = nodemailer.createTransport({
        host: String(args.config.host),
        port,
        secure: port === 465,
        requireTLS: String(args.config.use_tls) === 'true',
        auth: {
          user: args.credentials.username,
          pass: args.credentials.password,
        },
      });
      const fromEmail = String(args.config.from_email || args.from);
      const fromName = args.fromName || String(args.config.from_name || '');
      const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
      const result = await transporter.sendMail({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      });
      return { status: 'sent', messageId: result.messageId };
    } catch (err: any) {
      console.error('[smtp] send failed:', err);
      return { status: 'failed', error: err?.message || String(err) };
    }
  },
};
