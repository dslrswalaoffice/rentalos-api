import type { WhatsAppAdapter, AdapterMetadata } from './types.js';

// ============================================================================
// src/lib/adapters/wati.ts  (Sub-turn 6f)
// ----------------------------------------------------------------------------
// Concrete WhatsApp adapter over WATI (https://wati.io), the WhatsApp Business
// API provider most Indian SMBs use. WhatsApp only sends PRE-APPROVED templates
// for business-initiated messages — the template name + variable order live in
// workspace settings; this adapter posts the rendered parameters to WATI's
// sendTemplateMessage endpoint using native fetch (no new dependency).
//
// WATI's request/response shape has shifted across API versions; this targets
// the v1 template-send endpoint. If a workspace's WATI account differs, adjust
// here. Docs: https://docs.wati.io/reference/sendtemplatemessagepost
// ============================================================================

const metadata: AdapterMetadata = {
  provider: 'wati',
  displayName: 'WATI',
  category: 'whatsapp',
  description: 'Popular WhatsApp Business API provider for Indian SMBs.',
  helpUrl: 'https://docs.wati.io',
  credentialFields: [
    { key: 'api_key', label: 'API Access Token', type: 'password', required: true },
  ],
  configFields: [
    { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://live-server-XXXXX.wati.io' },
  ],
  supportsTest: false,
  implemented: true,
};

// E.164-ish: strip non-digits; assume Indian (+91) when a bare 10-digit number.
function formatPhoneE164(phone: string): string {
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length === 10) return '91' + digits;
  return digits;
}

export const watiWhatsAppAdapter: WhatsAppAdapter = {
  metadata,
  async sendTemplate(args) {
    try {
      const baseUrl = String(args.config.base_url).replace(/\/$/, '');
      const phone = formatPhoneE164(args.to);
      const apiKey = args.credentials.api_key || '';

      const params = Object.entries(args.variables).map(([name, value]) => ({
        name,
        value: String(value ?? ''),
      }));

      const url = `${baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${phone}`;
      const body = {
        template_name: args.templateName,
        broadcast_name: `${args.templateName}_reminder`,
        parameters: params,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        return { status: 'failed', error: `WATI ${res.status}: ${errText.slice(0, 200)}` };
      }

      const data = (await res.json()) as any;
      const isSuccess = data?.result === true || data?.result === 'success' || data?.ok === true;
      if (isSuccess) {
        return { status: 'sent', messageId: data.messageId || data.id || `wati-${phone}` };
      }
      return { status: 'failed', error: JSON.stringify(data).slice(0, 200) };
    } catch (err: any) {
      console.error('[wati] send failed:', err);
      return { status: 'failed', error: err?.message || String(err) };
    }
  },
};
