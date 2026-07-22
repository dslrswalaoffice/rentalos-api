import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission, can } from '../lib/permissions.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import { uploadKYCFiles, KYC_ALLOWED_TYPES } from '../lib/kyc_upload.js';
import {
  createKYCDocument, verifyKYCDocument, rejectKYCDocument,
  kycCategory,
} from '../lib/kyc_lifecycle.js';

// ============================================================================
// src/routes/kyc.ts (Slice 8 Session 1) — KYC review workflow.
// Mounted at /api/kyc (see src/app.ts). Person-scoped upload/list live under
// /api/kyc/people/:personId/... ; review lives under /api/kyc/queue +
// /api/kyc/documents/:docId/... . Reconciled path (the idealized spec named
// /api/people/:personId/kyc/... ; a dedicated router keeps KYC self-contained
// and the person list-filter is the only people.ts touch).
//
// Permissions: upload -> people.manage; read -> people.view; file URLs + queue
// -> people.view_sensitive; verify/reject -> people.review_kyc.
// ============================================================================

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

export const kyc = new Hono<Env>();
kyc.use('*', sessionMiddleware, requireAuth, idempotencyMiddleware);

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}

const DOC_TYPES = ['aadhaar', 'pan', 'driving_license', 'passport', 'gst_certificate', 'other'] as const;
const REJECTION_REASONS = ['unclear_image', 'document_expired', 'name_mismatch', 'suspected_fraud', 'wrong_document_type', 'other'] as const;

async function loadPersonLite(personId: string, workspaceId: string) {
  const rows = await query<{ id: string; display_name: string; company_name: string | null; kyc_status: string }>(sql`
    SELECT id, display_name, company_name, kyc_status FROM people
    WHERE id = ${personId}::uuid AND workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL LIMIT 1
  `);
  return rows[0] ?? null;
}

async function requiredDocsFor(workspaceId: string, category: 'individual' | 'b2b'): Promise<string[]> {
  const rows = await query<{ list: string[] | null }>(sql`
    SELECT ARRAY(SELECT jsonb_array_elements_text(
      COALESCE(settings->'kyc_policy'->'required_documents'->${category}::text, '[]'::jsonb)))::text[] AS list
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  const list = rows[0]?.list ?? [];
  if (list.length) return list;
  return category === 'b2b' ? ['gst_certificate'] : ['aadhaar', 'pan'];
}

// Map a document row to the client shape. File URLs are only exposed to holders
// of people.view_sensitive; others see file COUNT + metadata but not the URLs.
function shapeDoc(d: any, canSeeFiles: boolean) {
  const files = Array.isArray(d.files) ? d.files : [];
  return {
    id: d.id, document_type: d.document_type, document_number: d.document_number,
    status: d.status, rejection_reason: d.rejection_reason, rejection_notes: d.rejection_notes,
    verified_at: d.verified_at, submitted_at: d.submitted_at,
    file_count: files.length,
    files: canSeeFiles ? files : files.map((f: any) => ({ mime_type: f.mime_type, filename: f.filename, size_bytes: f.size_bytes, uploaded_at: f.uploaded_at })),
  };
}

// ============================================================================
// POST /people/:personId/documents — multipart upload (fields: document_type,
// document_number?, files[]). Creates a kyc_documents row (status 'pending').
// ============================================================================
kyc.post('/people/:personId/documents', requirePermission('people.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const personId = c.req.param('personId');

  const person = await loadPersonLite(personId, session.workspace.id);
  if (!person) return c.json({ error: 'person_not_found' }, 404);

  let documentType = ''; let documentNumber: string | null = null; const files: File[] = [];
  try {
    const form = await c.req.formData();
    documentType = String(form.get('document_type') ?? '');
    const dn = form.get('document_number'); documentNumber = dn ? String(dn) : null;
    for (const raw of form.getAll('files')) if (raw instanceof File) files.push(raw);
  } catch {
    return c.json({ error: 'invalid_multipart' }, 400);
  }
  if (!(DOC_TYPES as readonly string[]).includes(documentType)) {
    return c.json({ error: 'invalid_document_type', allowed: DOC_TYPES }, 400);
  }
  if (!files.length) return c.json({ error: 'no_files' }, 400);

  const up = await uploadKYCFiles({ workspaceId: session.workspace.id, personId, documentType, files });
  if (!up.ok) return c.json({ error: up.error, detail: up.detail, allowed_types: KYC_ALLOWED_TYPES }, 400);

  const created = await createKYCDocument({
    workspaceId: session.workspace.id, personId, actorUserId: session.user.id,
    documentType, documentNumber, files: up.files, ipAddress, userAgent,
  });
  const updated = await loadPersonLite(personId, session.workspace.id);
  return c.json({ document_id: created.id, kyc_status: updated?.kyc_status ?? 'pending', files: up.files }, 201);
});

// ============================================================================
// GET /people/:personId/documents — list documents + KYC summary for a person.
// ============================================================================
kyc.get('/people/:personId/documents', requirePermission('people.view'), async (c) => {
  const session = c.get('session')!;
  const personId = c.req.param('personId');
  const person = await loadPersonLite(personId, session.workspace.id);
  if (!person) return c.json({ error: 'person_not_found' }, 404);

  const canSeeFiles = can(session, 'people.view_sensitive');
  const docs = await query<any>(sql`
    SELECT id, document_type, document_number, files, status::text AS status,
           rejection_reason, rejection_notes, verified_at, submitted_at
    FROM kyc_documents
    WHERE person_id = ${personId}::uuid AND workspace_id = ${session.workspace.id}::uuid
    ORDER BY submitted_at DESC
  `);
  const category = kycCategory(person.company_name);
  const required = await requiredDocsFor(session.workspace.id, category);
  const verifiedTypes = new Set(docs.filter((d) => d.status === 'verified').map((d) => d.document_type));
  const completeness = required.length ? Math.round((required.filter((t) => verifiedTypes.has(t)).length / required.length) * 100) : 100;

  return c.json({
    person: { id: person.id, display_name: person.display_name, kyc_status: person.kyc_status },
    category, required_documents: required, completeness_pct: completeness,
    can_review: can(session, 'people.review_kyc'), can_view_files: canSeeFiles,
    documents: docs.map((d) => shapeDoc(d, canSeeFiles)),
  });
});

// ============================================================================
// GET /queue — pending documents across the workspace (FIFO). Review desk.
// Filters: ?document_type= &q= (person search) &submitted_after=. Paginated.
// ============================================================================
kyc.get('/queue', requirePermission('people.view_sensitive'), async (c) => {
  const session = c.get('session')!;
  const docType = c.req.query('document_type') ?? null;
  const q = (c.req.query('q') ?? '').trim();
  const submittedAfter = c.req.query('submitted_after') ?? null;
  const statusFilter = c.req.query('status') ?? 'pending'; // pending | rejected
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

  const rows = await query<any>(sql`
    SELECT d.id, d.document_type, d.document_number, d.files, d.status::text AS status,
           d.submitted_at, d.rejection_reason,
           p.id AS person_id, p.display_name AS person_name, p.company_name, p.phone
    FROM kyc_documents d
    JOIN people p ON p.id = d.person_id AND p.workspace_id = d.workspace_id
    WHERE d.workspace_id = ${session.workspace.id}::uuid
      AND d.status = ${statusFilter}::text
      AND (${docType}::text IS NULL OR d.document_type = ${docType}::text)
      AND (${submittedAfter}::timestamptz IS NULL OR d.submitted_at >= ${submittedAfter}::timestamptz)
      AND (${q}::text = '' OR p.display_name ILIKE '%' || ${q}::text || '%' OR p.phone ILIKE '%' || ${q}::text || '%')
      AND p.deleted_at IS NULL
    ORDER BY d.submitted_at ASC
    LIMIT ${limit}::int OFFSET ${offset}::int
  `);
  const countRows = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM kyc_documents d JOIN people p ON p.id = d.person_id
    WHERE d.workspace_id = ${session.workspace.id}::uuid AND d.status = ${statusFilter}::text AND p.deleted_at IS NULL
  `);
  return c.json({
    total: countRows[0]?.n ?? 0, limit, offset,
    documents: rows.map((r) => ({
      ...shapeDoc(r, true),
      person: { id: r.person_id, display_name: r.person_name, company_name: r.company_name, phone: r.phone,
                category: kycCategory(r.company_name) },
    })),
  });
});

// ============================================================================
// POST /documents/:docId/verify  — people.review_kyc (Idempotency-Key aware).
// ============================================================================
kyc.post('/documents/:docId/verify', requirePermission('people.review_kyc'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await verifyKYCDocument({ workspaceId: session.workspace.id, documentId: c.req.param('docId'), actorUserId: session.user.id, ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 404);
  return c.json(r);
});

// ============================================================================
// POST /documents/:docId/reject  — body {reason, notes?} — people.review_kyc.
// ============================================================================
export const rejectSchema = z.object({
  reason: z.enum(REJECTION_REASONS),
  notes:  z.string().max(1000).optional(),
});
kyc.post('/documents/:docId/reject', requirePermission('people.review_kyc'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => null);
  const parsed = rejectSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const r = await rejectKYCDocument({
    workspaceId: session.workspace.id, documentId: c.req.param('docId'), actorUserId: session.user.id,
    reason: parsed.data.reason, notes: parsed.data.notes ?? null, ipAddress, userAgent,
  });
  if (!r.ok) return c.json({ error: r.error }, 404);
  return c.json(r);
});

// ============================================================================
// GET /documents/:docId/files/:idx — redirect to the Vercel Blob file URL.
// people.view_sensitive only. (Blob URLs are public-but-unguessable; this adds
// the permission gate + keeps the URL out of lower-privilege responses.)
// ============================================================================
kyc.get('/documents/:docId/files/:idx', requirePermission('people.view_sensitive'), async (c) => {
  const session = c.get('session')!;
  const idx = Number(c.req.param('idx'));
  const rows = await query<{ files: any }>(sql`
    SELECT files FROM kyc_documents WHERE id = ${c.req.param('docId')}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `);
  const files = Array.isArray(rows[0]?.files) ? rows[0]!.files : [];
  const f = files[idx];
  if (!f || !f.url) return c.json({ error: 'file_not_found' }, 404);
  return c.redirect(String(f.url), 302);
});
