// ============================================================================
// src/lib/kyc_lifecycle.ts (Slice 8 Session 1) — the nascent Identity Engine.
// ----------------------------------------------------------------------------
// Canonical KYC orchestration: people.kyc_status is DERIVED from kyc_documents,
// exactly the way orders.deposit_status is derived from deposit-kind payments
// (Money Engine). Verify/reject a document -> recompute the person rollup ->
// audit + (optional) customer notification.
//
// Reconciled to shipped reality: there is no person_events timeline table, so
// KYC status changes write to audit_events only (the universal mutation log).
//
// Fail-soft: a notification failure never blocks a status change.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { emitCustomerNotification, type CustomerChannel } from './notify.js';

type WsSettings = Record<string, any> | null;

// Human labels for the config-driven rejection taxonomy (SET is workspace config;
// only the display formatting lives here — same posture as forfeit-reason labels).
export const KYC_REJECTION_LABEL: Record<string, string> = {
  unclear_image: 'The document image was unclear',
  document_expired: 'The document has expired',
  name_mismatch: 'The name did not match',
  suspected_fraud: 'The document could not be validated',
  wrong_document_type: 'The wrong document type was uploaded',
  other: 'Additional verification is required',
};

const DEFAULT_REQUIRED = { individual: ['aadhaar', 'pan'], b2b: ['gst_certificate'] };

async function loadWsSettings(workspaceId: string): Promise<WsSettings> {
  const rows = await query<{ settings: WsSettings }>(sql`SELECT settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1`);
  return rows[0]?.settings ?? {};
}

type PersonKyc = {
  id: string; display_name: string; company_name: string | null;
  phone: string | null; email: string | null; customer_person_kyc: string;
};

async function loadPerson(personId: string, workspaceId: string): Promise<PersonKyc | null> {
  const rows = await query<PersonKyc>(sql`
    SELECT id, display_name, company_name, phone, email, kyc_status AS customer_person_kyc
    FROM people WHERE id = ${personId}::uuid AND workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL LIMIT 1
  `);
  return rows[0] ?? null;
}

/** individual vs b2b is auto-detected from company_name (Q4). */
export function kycCategory(companyName: string | null | undefined): 'individual' | 'b2b' {
  return companyName && String(companyName).trim() ? 'b2b' : 'individual';
}

function requiredDocsFor(settings: WsSettings, category: 'individual' | 'b2b'): string[] {
  const rd = settings?.kyc_policy?.required_documents;
  const list = rd?.[category];
  return Array.isArray(list) && list.length ? list.map(String) : DEFAULT_REQUIRED[category];
}

/**
 * Derive the person's kyc_status from their documents + the workspace policy.
 *   no documents at all            -> not_started
 *   every required type verified   -> verified
 *   any required type rejected     -> rejected  (needs re-submit)
 *   otherwise                      -> pending
 */
export function deriveKycStatus(
  required: string[],
  docsByType: Map<string, Set<string>>, // type -> set of statuses present
  anyDocs: boolean,
): 'not_started' | 'pending' | 'verified' | 'rejected' {
  if (!anyDocs) return 'not_started';
  const typeVerified = (t: string) => docsByType.get(t)?.has('verified') ?? false;
  const typeRejectedOnly = (t: string) => {
    const s = docsByType.get(t);
    return !!s && s.has('rejected') && !s.has('verified') && !s.has('pending');
  };
  if (required.every(typeVerified)) return 'verified';
  if (required.some(typeRejectedOnly)) return 'rejected';
  return 'pending';
}

export type RecomputeResult = { old: string; new: string; changed: boolean };

/**
 * Recompute + persist people.kyc_status from kyc_documents. Audits + notifies on
 * change. Never throws for the notification path (fail-soft).
 */
export async function recomputeKYCStatus(args: {
  workspaceId: string; personId: string; actorUserId: string;
  settings?: WsSettings; ipAddress?: string | null; userAgent?: string | null;
}): Promise<RecomputeResult | null> {
  const { workspaceId, personId, actorUserId } = args;
  const ipAddress = args.ipAddress ?? null;
  const userAgent = args.userAgent ?? null;
  const settings = args.settings ?? (await loadWsSettings(workspaceId));

  const person = await loadPerson(personId, workspaceId);
  if (!person) return null;
  const oldStatus = person.customer_person_kyc;

  const docs = await query<{ document_type: string; status: string }>(sql`
    SELECT document_type, status FROM kyc_documents
    WHERE person_id = ${personId}::uuid AND workspace_id = ${workspaceId}::uuid
  `);
  const byType = new Map<string, Set<string>>();
  for (const d of docs) {
    if (!byType.has(d.document_type)) byType.set(d.document_type, new Set());
    byType.get(d.document_type)!.add(d.status);
  }
  const required = requiredDocsFor(settings, kycCategory(person.company_name));
  const newStatus = deriveKycStatus(required, byType, docs.length > 0);

  if (newStatus === oldStatus) {
    // still stamp last_reviewed_at so the queue can sort by review recency
    await sql`UPDATE people SET kyc_last_reviewed_at = now() WHERE id = ${personId}::uuid AND workspace_id = ${workspaceId}::uuid`;
    return { old: oldStatus, new: newStatus, changed: false };
  }

  const rejectionReason = newStatus === 'rejected'
    ? (await query<{ r: string | null }>(sql`
        SELECT rejection_reason AS r FROM kyc_documents
        WHERE person_id = ${personId}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'rejected'
        ORDER BY updated_at DESC LIMIT 1`))[0]?.r ?? null
    : null;

  await sql`
    UPDATE people SET
      kyc_status = ${newStatus}::text,
      kyc_verified_by_user_id = ${newStatus === 'verified' ? actorUserId : null}::uuid,
      kyc_verified_at   = CASE WHEN ${newStatus === 'verified'}::boolean THEN now() ELSE NULL END,
      kyc_rejection_reason = ${rejectionReason}::text,
      kyc_last_reviewed_at = now(),
      updated_at = now()
    WHERE id = ${personId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;

  await audit({
    workspaceId, actorUserId, eventType: 'people.kyc.status_changed',
    targetType: 'person', targetId: personId,
    payload: { from: oldStatus, to: newStatus, category: kycCategory(person.company_name), required, rejection_reason: rejectionReason },
    ipAddress, userAgent,
  });

  // Customer notification on a terminal transition (fail-soft).
  const notify = settings?.kyc_policy?.notify_customer_on_status_change !== false;
  if (notify && (newStatus === 'verified' || newStatus === 'rejected')) {
    try {
      const wsName = (await query<{ name: string; phone: string | null }>(sql`SELECT name, business_phone AS phone FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1`))[0];
      const supportPhone = wsName?.phone ?? '';
      const channels = ['whatsapp', 'email'].filter((ch): ch is CustomerChannel => ch === 'whatsapp' || ch === 'email');
      const reasonDisplay = rejectionReason ? (KYC_REJECTION_LABEL[rejectionReason] ?? rejectionReason.replace(/_/g, ' ')) : '';
      await emitCustomerNotification({
        workspaceId, orderId: '', personId,
        eventType: newStatus === 'verified' ? 'kyc_approved' : 'kyc_rejected',
        message: newStatus === 'verified'
          ? `Your KYC verification for ${wsName?.name ?? ''} is complete. You are all set to rent.`
          : `Your KYC verification needs attention: ${reasonDisplay}. Please contact ${supportPhone}.`,
        channels, contact: { phone: person.phone, email: person.email }, settings,
        variables: { customer_name: person.display_name, rejection_reason_display: reasonDisplay, support_phone: supportPhone },
      });
    } catch (e) { console.error('[kyc_lifecycle] notification failed', e); }
  }

  return { old: oldStatus, new: newStatus, changed: true };
}

/** Create a kyc_documents row (status 'pending') from an uploaded file manifest. */
export async function createKYCDocument(args: {
  workspaceId: string; personId: string; actorUserId: string;
  documentType: string; documentNumber: string | null; files: unknown[];
  ipAddress?: string | null; userAgent?: string | null;
}): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(sql`
    INSERT INTO kyc_documents (workspace_id, person_id, document_type, document_number, files, status, submitted_by_user_id, submitted_at)
    VALUES (${args.workspaceId}::uuid, ${args.personId}::uuid, ${args.documentType}::text,
            ${args.documentNumber ?? null}::text, ${JSON.stringify(args.files)}::jsonb, 'pending', ${args.actorUserId}::uuid, now())
    RETURNING id
  `);
  const id = rows[0]!.id;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'people.kyc.document_submitted',
    targetType: 'kyc_document', targetId: id,
    payload: { person_id: args.personId, document_type: args.documentType, file_count: args.files.length },
    ipAddress: args.ipAddress ?? null, userAgent: args.userAgent ?? null,
  });
  await recomputeKYCStatus({ workspaceId: args.workspaceId, personId: args.personId, actorUserId: args.actorUserId, ipAddress: args.ipAddress, userAgent: args.userAgent });
  return { id };
}

type DocRow = { id: string; person_id: string; status: string; document_type: string };
async function loadDoc(documentId: string, workspaceId: string): Promise<DocRow | null> {
  const rows = await query<DocRow>(sql`
    SELECT id, person_id, status::text AS status, document_type FROM kyc_documents
    WHERE id = ${documentId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0] ?? null;
}

export type DocDecisionResult =
  | { ok: true; document_id: string; person_id: string; kyc_status: string }
  | { ok: false; error: string };

/** Verify a document, then recompute the person rollup. */
export async function verifyKYCDocument(args: {
  workspaceId: string; documentId: string; actorUserId: string; ipAddress?: string | null; userAgent?: string | null;
}): Promise<DocDecisionResult> {
  const doc = await loadDoc(args.documentId, args.workspaceId);
  if (!doc) return { ok: false, error: 'document_not_found' };
  await sql`
    UPDATE kyc_documents SET status = 'verified', verified_by_user_id = ${args.actorUserId}::uuid, verified_at = now(),
      rejection_reason = NULL, rejection_notes = NULL, updated_at = now()
    WHERE id = ${doc.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'people.kyc.document_verified',
    targetType: 'kyc_document', targetId: doc.id, payload: { person_id: doc.person_id, document_type: doc.document_type },
    ipAddress: args.ipAddress ?? null, userAgent: args.userAgent ?? null,
  });
  const rc = await recomputeKYCStatus({ workspaceId: args.workspaceId, personId: doc.person_id, actorUserId: args.actorUserId, ipAddress: args.ipAddress, userAgent: args.userAgent });
  return { ok: true, document_id: doc.id, person_id: doc.person_id, kyc_status: rc?.new ?? 'pending' };
}

/** Reject a document with a reason, then recompute the person rollup. */
export async function rejectKYCDocument(args: {
  workspaceId: string; documentId: string; actorUserId: string;
  reason: string; notes: string | null; ipAddress?: string | null; userAgent?: string | null;
}): Promise<DocDecisionResult> {
  const doc = await loadDoc(args.documentId, args.workspaceId);
  if (!doc) return { ok: false, error: 'document_not_found' };
  await sql`
    UPDATE kyc_documents SET status = 'rejected', rejection_reason = ${args.reason}::text, rejection_notes = ${args.notes ?? null}::text,
      verified_by_user_id = ${args.actorUserId}::uuid, verified_at = NULL, updated_at = now()
    WHERE id = ${doc.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'people.kyc.document_rejected',
    targetType: 'kyc_document', targetId: doc.id,
    payload: { person_id: doc.person_id, document_type: doc.document_type, reason: args.reason },
    ipAddress: args.ipAddress ?? null, userAgent: args.userAgent ?? null,
  });
  const rc = await recomputeKYCStatus({ workspaceId: args.workspaceId, personId: doc.person_id, actorUserId: args.actorUserId, ipAddress: args.ipAddress, userAgent: args.userAgent });
  return { ok: true, document_id: doc.id, person_id: doc.person_id, kyc_status: rc?.new ?? 'rejected' };
}
