// ============================================================================
// src/lib/invoice_pdf.ts (Slice 6 Session 1) — GST-compliant invoice PDF.
// ----------------------------------------------------------------------------
// Renders a frozen invoice `snapshot` (built by generateInvoice in
// src/routes/invoices.ts — workspace, customer, order, line items with the
// CGST/SGST/IGST split, payments, totals, gst-meta) into an A4 PDF via pdfkit.
//
// DETERMINISTIC: the same (invoice, branding) input always produces a
// byte-identical PDF (verified) — CreationDate is FIXED from the snapshot's
// generated_at, never now(). This preserves revision integrity: regenerating an
// issued invoice yields the exact same bytes.
//
// v1 uses the built-in Helvetica (no embedded fonts). Helvetica's encoding has no
// Rupee glyph, so currency is written "Rs." — an embedded Unicode font for the
// native "Rs." symbol is a v2 concern (documented). Amounts are integer paise,
// formatted with Indian digit grouping.
// ============================================================================

import PDFDocument from 'pdfkit';
import { put } from '@vercel/blob';
import { sql, query } from '../db.js';

type Snapshot = {
  workspace?: { legal_name?: string | null; gstin?: string | null; pan?: string | null; place_of_supply?: string | null; business_address?: string | null; phone?: string | null; email?: string | null };
  customer?: { display_name?: string | null; company_name?: string | null; phone?: string | null; email?: string | null; gstin?: string | null; billing_address?: string | null; shipping_address?: string | null } | null;
  order?: { order_number?: number | string; rental_start?: string | null; rental_end?: string | null; notes?: string | null };
  line_items?: Array<{ description?: string; product_name?: string | null; hsn_code?: string | null; quantity?: number; unit_amount_paise?: string; total_amount_paise?: string; chargeable_paise?: string; cgst_paise?: string; sgst_paise?: string; igst_paise?: string; item_type?: string }>;
  totals?: { subtotal_paise?: string; discount_paise?: string; tax_paise?: string; cgst_paise?: string; sgst_paise?: string; igst_paise?: string; total_paise?: string; paid_paise?: string; balance_paise?: string };
  gst?: { is_intra_state?: boolean; tax_pct?: number };
  generated_at?: string;
};

export type InvoiceForPdf = {
  invoice_number: string;
  issued_at: string | Date;
  due_date?: string | Date | null;
  status: string;
  place_of_supply?: string | null;
  snapshot: Snapshot;
};

export type InvoiceBranding = {
  terms_and_conditions?: string | null;
  bank_details?: string | null;
  footer_note?: string | null;
};

// ---- formatting ----
const n = (v: unknown): number => Number(v ?? 0);

/** paise -> "1,23,456.00" (Indian grouping, 2 decimals). */
export function paiseToINR(paise: number | string): string {
  const p = Math.round(n(paise));
  const neg = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const paise2 = String(abs % 100).padStart(2, '0');
  const s = String(rupees);
  // Indian grouping: last 3 digits, then pairs.
  let grouped: string;
  if (s.length <= 3) grouped = s;
  else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }
  return (neg ? '-' : '') + grouped + '.' + paise2;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(x: number): string {
  if (x < 20) return ONES[x]!;
  return (TENS[Math.floor(x / 10)]! + (x % 10 ? ' ' + ONES[x % 10] : '')).trim();
}
function threeDigits(x: number): string {
  const h = Math.floor(x / 100), r = x % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ').trim();
}
/** Indian-system amount in words for a rupee total (crore/lakh/thousand). */
export function rupeesInWords(paise: number | string): string {
  const p = Math.round(n(paise));
  const rupees = Math.floor(Math.abs(p) / 100);
  const paise2 = Math.abs(p) % 100;
  if (rupees === 0 && paise2 === 0) return 'Zero Rupees Only';
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  const parts: string[] = [];
  if (crore) parts.push(twoDigits(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (rest) parts.push(threeDigits(rest));
  let words = parts.join(' ').trim() + ' Rupees';
  if (paise2) words += ' and ' + twoDigits(paise2) + ' Paise';
  return words + ' Only';
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const s = typeof d === 'string' ? d : d.toISOString();
  return s.slice(0, 10); // YYYY-MM-DD (already Asia/Kolkata date from generation)
}

/**
 * Render an invoice PDF. Returns a Buffer for Vercel Blob storage.
 * Deterministic: pass a fixed CreationDate derived from the snapshot.
 */
export function generateInvoicePDF(invoice: InvoiceForPdf, branding: InvoiceBranding = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const snap = invoice.snapshot ?? {};
      const ws = snap.workspace ?? {};
      const cust = snap.customer ?? null;
      const ord = snap.order ?? {};
      const lines = (snap.line_items ?? []).filter((l) => n(l.chargeable_paise) !== 0 || l.item_type !== 'discount');
      const totals = snap.totals ?? {};
      const gst = snap.gst ?? {};
      const intra = gst.is_intra_state !== false; // default intra unless explicitly inter

      // FIXED creation date -> deterministic output.
      const created = snap.generated_at ? new Date(snap.generated_at) : new Date(fmtDate(invoice.issued_at) + 'T00:00:00Z');
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Invoice ${invoice.invoice_number}`, Author: ws.legal_name ?? 'RentalOS', Producer: 'RentalOS', Creator: 'RentalOS', CreationDate: created } });
      const bufs: Buffer[] = [];
      doc.on('data', (b: Buffer) => bufs.push(b));
      doc.on('end', () => resolve(Buffer.concat(bufs)));

      const L = 40, R = 555; // usable width 40..555 on A4 (595 wide)
      const money = (v: unknown) => 'Rs. ' + paiseToINR(v as number);

      // ---- Header: workspace (left) + TAX INVOICE badge (right) ----
      doc.fontSize(17).font('Helvetica-Bold').fillColor('#202058').text(ws.legal_name ?? 'Invoice', L, 42, { width: 320 });
      doc.fontSize(8.5).font('Helvetica').fillColor('#444');
      const wsMeta = [ws.business_address, ws.phone ? 'Ph: ' + ws.phone : '', ws.email].filter(Boolean).join('\n');
      if (wsMeta) doc.text(wsMeta, L, doc.y + 2, { width: 320 });
      const gstLine = [ws.gstin ? 'GSTIN: ' + ws.gstin : '', ws.pan ? 'PAN: ' + ws.pan : ''].filter(Boolean).join('   ');
      if (gstLine) doc.font('Helvetica-Bold').fontSize(9).fillColor('#202058').text(gstLine, L, doc.y + 3, { width: 320 });
      doc.fontSize(15).font('Helvetica-Bold').fillColor('#059669').text('TAX INVOICE', 360, 44, { width: R - 360, align: 'right' });

      // ---- Invoice metadata (right box) ----
      let my = 78;
      const metaRow = (k: string, v: string) => { doc.fontSize(8.5).font('Helvetica').fillColor('#888').text(k, 360, my, { width: 90, align: 'right' }); doc.font('Helvetica-Bold').fillColor('#202058').text(v, 452, my, { width: R - 452, align: 'right' }); my += 13; };
      metaRow('Invoice #', invoice.invoice_number);
      metaRow('Date', fmtDate(invoice.issued_at));
      metaRow('Due', fmtDate(invoice.due_date));
      metaRow('Place of supply', invoice.place_of_supply ?? ws.place_of_supply ?? '—');
      metaRow('Status', String(invoice.status).toUpperCase());

      doc.moveTo(L, 150).lineTo(R, 150).strokeColor('#ddd').stroke();

      // ---- Bill to / Ship to ----
      let by = 160;
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('BILL TO', L, by);
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor('#202058').text(cust?.company_name || cust?.display_name || 'Customer', L, by + 11, { width: 250 });
      doc.fontSize(8.5).font('Helvetica').fillColor('#444');
      const custMeta = [cust?.billing_address, cust?.phone, cust?.email, cust?.gstin ? 'GSTIN: ' + cust.gstin : ''].filter(Boolean).join('\n');
      if (custMeta) doc.text(custMeta, L, doc.y + 2, { width: 250 });
      // rental period (right)
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('RENTAL PERIOD', 320, by);
      doc.fontSize(9).font('Helvetica').fillColor('#202058').text(fmtDate(ord.rental_start) + '  to  ' + fmtDate(ord.rental_end), 320, by + 11, { width: R - 320 });
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('ORDER', 320, by + 30);
      doc.fontSize(9).font('Helvetica').fillColor('#202058').text('#' + (ord.order_number ?? ''), 320, by + 41);

      // ---- Line items table ----
      let ty = Math.max(doc.y, by + 60) + 8;
      const cols = intra
        ? [{ x: L, w: 170, t: 'Description', a: 'left' }, { x: 210, w: 44, t: 'HSN', a: 'left' }, { x: 254, w: 26, t: 'Qty', a: 'right' }, { x: 282, w: 66, t: 'Taxable', a: 'right' }, { x: 350, w: 66, t: 'CGST', a: 'right' }, { x: 418, w: 66, t: 'SGST', a: 'right' }, { x: 486, w: 69, t: 'Total', a: 'right' }]
        : [{ x: L, w: 200, t: 'Description', a: 'left' }, { x: 244, w: 50, t: 'HSN', a: 'left' }, { x: 296, w: 30, t: 'Qty', a: 'right' }, { x: 328, w: 90, t: 'Taxable', a: 'right' }, { x: 420, w: 66, t: 'IGST', a: 'right' }, { x: 488, w: 67, t: 'Total', a: 'right' }];
      const drawHead = (yy: number) => {
        doc.rect(L, yy, R - L, 16).fill('#f0f2f5');
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#444');
        for (const c of cols) doc.text(c.t, c.x, yy + 5, { width: c.w, align: c.a as 'left' | 'right' });
        return yy + 16;
      };
      ty = drawHead(ty);
      doc.font('Helvetica').fontSize(8).fillColor('#202058');
      for (const li of lines) {
        if (ty > 720) { doc.addPage(); ty = drawHead(50); doc.font('Helvetica').fontSize(8).fillColor('#202058'); }
        const taxable = n(li.chargeable_paise);
        const rowH = 15;
        const cell = (idx: number, txt: string) => { const c = cols[idx]!; doc.text(txt, c.x, ty + 3, { width: c.w, align: c.a as 'left' | 'right' }); };
        cell(0, li.description || li.product_name || '');
        cell(1, li.hsn_code || '—');
        cell(2, String(li.quantity ?? 1));
        cell(3, paiseToINR(taxable));
        if (intra) { cell(4, paiseToINR(li.cgst_paise ?? 0)); cell(5, paiseToINR(li.sgst_paise ?? 0)); cell(6, paiseToINR(taxable + n(li.cgst_paise) + n(li.sgst_paise))); }
        else { cell(4, paiseToINR(li.igst_paise ?? 0)); cell(5, paiseToINR(taxable + n(li.igst_paise))); }
        doc.moveTo(L, ty + rowH).lineTo(R, ty + rowH).strokeColor('#eee').stroke();
        ty += rowH;
      }

      // ---- Totals block (right) ----
      ty += 10;
      let toy = ty;
      const totRow = (k: string, v: string, bold = false) => { doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold ? '#202058' : '#444'); doc.text(k, 330, toy, { width: 120, align: 'right' }); doc.text(v, 452, toy, { width: R - 452, align: 'right' }); toy += 14; };
      totRow('Subtotal', money(totals.subtotal_paise));
      if (n(totals.discount_paise) !== 0) totRow('Discount', '- ' + money(Math.abs(n(totals.discount_paise))));
      if (intra) { totRow('CGST', money(totals.cgst_paise)); totRow('SGST', money(totals.sgst_paise)); }
      else totRow('IGST', money(totals.igst_paise));
      doc.moveTo(330, toy + 1).lineTo(R, toy + 1).strokeColor('#ccc').stroke(); toy += 5;
      totRow('Grand Total', money(totals.total_paise), true);
      if (n(totals.paid_paise) !== 0) { totRow('Paid', money(totals.paid_paise)); totRow('Balance Due', money(totals.balance_paise), true); }

      // amount in words (left, aligned with totals)
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#888').text('AMOUNT IN WORDS', L, ty);
      doc.fontSize(9).font('Helvetica-Oblique').fillColor('#202058').text(rupeesInWords(totals.total_paise ?? 0), L, ty + 12, { width: 280 });

      // ---- Footer: bank details + terms + signature ----
      let fy = Math.max(toy, ty + 50) + 16;
      if (fy > 700) { doc.addPage(); fy = 60; }
      if (branding.bank_details) { doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('BANK DETAILS', L, fy); doc.fontSize(8.5).font('Helvetica').fillColor('#444').text(branding.bank_details, L, fy + 11, { width: 280 }); }
      if (branding.terms_and_conditions) { doc.fontSize(8).font('Helvetica-Bold').fillColor('#888').text('TERMS & CONDITIONS', L, Math.max(doc.y, fy) + 8); doc.fontSize(7.5).font('Helvetica').fillColor('#666').text(branding.terms_and_conditions, L, doc.y + 2, { width: R - L }); }
      // signature line (right)
      doc.fontSize(8.5).font('Helvetica').fillColor('#444').text('For ' + (ws.legal_name ?? ''), 380, fy + 20, { width: R - 380, align: 'right' });
      doc.moveTo(400, fy + 55).lineTo(R, fy + 55).strokeColor('#999').stroke();
      doc.fontSize(8).fillColor('#888').text('Authorised Signatory', 380, fy + 58, { width: R - 380, align: 'right' });
      if (branding.footer_note) doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#999').text(branding.footer_note, L, 800, { width: R - L, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}

// ---------------------------------------------------------------------------
// Generate the PDF for a stored invoice and persist it to Vercel Blob (or a
// data: URI when no blob token) into invoices.pdf_url. Shared by the
// POST /pdf/generate endpoint and the auto-close path. Idempotent: returns the
// existing pdf_url unless force=true. Branding (bank/terms/footer) comes from
// workspaces.settings.invoice_policy so it's a pure function of stored state.
// ---------------------------------------------------------------------------
export async function generateAndStoreInvoicePdf(
  workspaceId: string,
  invoiceId: string,
  opts: { force?: boolean } = {},
): Promise<{ pdf_url: string; regenerated: boolean } | { error: string }> {
  const rows = await query<{
    invoice_number: string; issued_at: string; due_date: string | null; status: string;
    place_of_supply: string | null; snapshot: Snapshot; pdf_url: string | null;
  }>(sql`
    SELECT invoice_number, issued_at::text AS issued_at, due_date::text AS due_date, status::text AS status,
           place_of_supply, snapshot, pdf_url
    FROM invoices WHERE id = ${invoiceId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const inv = rows[0];
  if (!inv) return { error: 'invoice_not_found' };
  if (inv.pdf_url && !opts.force) return { pdf_url: inv.pdf_url, regenerated: false };

  const brandRows = await query<{ policy: InvoiceBranding | null }>(sql`
    SELECT settings->'invoice_policy' AS policy FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  const branding = brandRows[0]?.policy ?? {};

  const buffer = await generateInvoicePDF(
    { invoice_number: inv.invoice_number, issued_at: inv.issued_at, due_date: inv.due_date, status: inv.status, place_of_supply: inv.place_of_supply, snapshot: inv.snapshot },
    { terms_and_conditions: branding.terms_and_conditions ?? null, bank_details: branding.bank_details ?? null, footer_note: branding.footer_note ?? null },
  );

  let pdfUrl: string;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const path = `workspaces/${workspaceId}/invoices/${invoiceId}.pdf`;
    const blob = await put(path, buffer, { access: 'public', contentType: 'application/pdf', addRandomSuffix: false });
    pdfUrl = blob.url;
  } else {
    pdfUrl = `data:application/pdf;base64,${buffer.toString('base64')}`;
  }
  await sql`UPDATE invoices SET pdf_url = ${pdfUrl}::text WHERE id = ${invoiceId}::uuid AND workspace_id = ${workspaceId}::uuid`;
  return { pdf_url: pdfUrl, regenerated: true };
}
