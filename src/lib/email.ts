import { config } from './config.js';

// In dev, we log emails to the console so you can copy reset links locally.
// In prod, replace this with your email vendor (Resend, Postmark, SES).
// Keep the signature stable so the callers never change.

type EmailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(payload: EmailPayload): Promise<void> {
  if (config.isDev) {
    console.log('\n' + '━'.repeat(72));
    console.log('[email] TO:', payload.to);
    console.log('[email] SUBJECT:', payload.subject);
    console.log('─'.repeat(72));
    console.log(payload.text);
    console.log('━'.repeat(72) + '\n');
    return;
  }

  // TODO wire an actual provider here. Rough sketch for Resend:
  //
  // const res = await fetch('https://api.resend.com/emails', {
  //   method: 'POST',
  //   headers: {
  //     'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify({
  //     from: 'no-reply@dslrswala.com',
  //     to: payload.to,
  //     subject: payload.subject,
  //     text: payload.text,
  //     html: payload.html,
  //   }),
  // });
  // if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);

  throw new Error('Email provider not configured. Set RESEND_API_KEY and wire src/lib/email.ts.');
}

/**
 * Composes the reset-password email body. Kept separate so we can tweak copy
 * without touching send logic.
 */
export function buildResetEmail(displayName: string, resetUrl: string): EmailPayload {
  const first = displayName.split(' ')[0] ?? 'there';
  const text = [
    `Hi ${first},`,
    '',
    'You (or someone using your email) asked to reset your RentalOS password.',
    'Click this link to set a new one:',
    '',
    resetUrl,
    '',
    'The link expires in 30 minutes and can only be used once.',
    'If you didn\'t request this, ignore this email — your password will stay the same.',
    '',
    '— RentalOS · DSLRSWALA',
  ].join('\n');
  return {
    to: '', // caller fills
    subject: 'Reset your RentalOS password',
    text,
  };
}
