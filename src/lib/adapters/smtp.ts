import type { EmailAdapter, AdapterMetadata } from './types.js';

// ============================================================================
// src/lib/adapters/smtp.ts  (Sub-turn 6f)
// ----------------------------------------------------------------------------
// Concrete email adapter over nodemailer. Works with any SMTP server (Gmail
// app-password, custom relay, etc.). Credentials/config come from the active
// `email` workspace_integration.
//
// nodemailer is loaded LAZILY inside send() (perf audit F5): this module is
// reachable from api/index.ts via the adapter registry's top-level imports, so
// a static import would evaluate nodemailer on EVERY cold start even though it
// is only needed when a reminder email actually sends. The dynamic import is
// cached by the module loader after the first call, so warm sends pay nothing.
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
      // Resolve the SMTP username from credentials OR config. Historically the
      // Settings modal saved `username` (a text field) into `config`, not
      // `credentials`, so already-saved rows have it in config — read both so a
      // save made before the frontend fix still authenticates. Password is always
      // a credential (encrypted at rest).
      const user = args.credentials.username ?? (args.config.username as string | undefined) ?? '';
      const pass = args.credentials.password ?? '';
      // Fail with a CLEAR error instead of nodemailer's cryptic "Missing
      // credentials for PLAIN" when auth is incomplete (e.g. decrypt returned
      // empty, or the username never got saved).
      if (!user || !pass) {
        return {
          status: 'failed',
          error: `SMTP_AUTH_INCOMPLETE: ${!user ? 'username' : 'password'} is empty after loading saved credentials — re-save the SMTP integration (and verify INTEGRATION_ENC_KEY hasn't changed).`,
        };
      }
      const { default: nodemailer } = await import('nodemailer');
      const port = Number(args.config.port) || 587;
      const transporter = nodemailer.createTransport({
        host: String(args.config.host),
        port,
        secure: port === 465,
        requireTLS: String(args.config.use_tls) === 'true',
        auth: { user, pass },
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
