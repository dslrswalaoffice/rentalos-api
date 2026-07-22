// ============================================================================
// src/lib/kyc_upload.ts (Slice 8 Session 1) — KYC document upload to Vercel Blob.
// ----------------------------------------------------------------------------
// Extends the shipped Blob pattern (inventory product images / dispatch photos):
// same put()/access:'public'/workspace-scoped-path discipline, but adds
//   - application/pdf to the allowed types (KYC docs are often PDF scans)
//   - MULTIPLE files per document (Aadhaar front + back = 2 files, one doc row)
// and returns a files[] manifest for the kyc_documents.files jsonb column.
//
// Path convention keeps workspaces isolated in the shared Blob store:
//   workspaces/<workspace_id>/kyc/<person_id>/<document_type>/<uuid>.<ext>
//
// Requires BLOB_READ_WRITE_TOKEN in the Vercel project (same as 5f/Slice 4-6).
// ============================================================================

import { put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';

export const KYC_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const KYC_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file (matches the image cap)
export const KYC_MAX_FILES = 5;               // per document (front/back/extra pages)

export type KYCFile = {
  url: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
  uploaded_at: string;
};

export type UploadResult =
  | { ok: true; files: KYCFile[] }
  | { ok: false; error: string; detail?: string };

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

function kycBlobPath(workspaceId: string, personId: string, documentType: string, mime: string): string {
  const ext = EXT[mime] ?? 'bin';
  return `workspaces/${workspaceId}/kyc/${personId}/${documentType}/${randomUUID()}.${ext}`;
}

/** Only our own Vercel Blob URLs may be deleted — external URLs are left alone. */
export function isOwnedKycBlob(url: string | null | undefined): boolean {
  return !!url && url.includes('.blob.vercel-storage.com');
}

/**
 * Upload one or more files as a single KYC document's file set. Validates count,
 * type and size BEFORE any upload, so a bad file rejects the whole submission
 * (no partial writes). Returns the manifest for kyc_documents.files.
 * `nowIso` is passed in so the timestamp is deterministic/testable.
 */
export async function uploadKYCFiles(args: {
  workspaceId: string;
  personId: string;
  documentType: string;
  files: File[];
  nowIso?: string;
}): Promise<UploadResult> {
  const { workspaceId, personId, documentType, files } = args;
  // Typed, human-readable errors — NEVER a masked "upload_failed" (that opacity
  // cost a long debug on the KYC bug: the real cause, a missing Blob token, was
  // hidden behind a generic string). Each branch returns a specific code + a
  // detail the operator can read directly in the UI.
  if (!files.length) return { ok: false, error: 'no_files', detail: 'No files were provided.' };
  if (files.length > KYC_MAX_FILES) {
    return { ok: false, error: 'too_many_files', detail: `received ${files.length}, max ${KYC_MAX_FILES} per document` };
  }

  for (const f of files) {
    if (!(KYC_ALLOWED_TYPES as readonly string[]).includes(f.type)) {
      return { ok: false, error: 'invalid_mime_type', detail: `${f.name}: received ${f.type || 'unknown'}, expected ${KYC_ALLOWED_TYPES.join(' | ')}` };
    }
    if (f.size > KYC_MAX_BYTES) {
      return { ok: false, error: 'file_size_exceeded', detail: `${f.name}: received ${mb(f.size)}, cap ${mb(KYC_MAX_BYTES)}` };
    }
  }

  // Fail fast + explicit when the Blob token is absent in this environment — the
  // classic cause of an opaque put() failure (and the actual KYC-upload bug).
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { ok: false, error: 'blob_token_missing', detail: 'BLOB_READ_WRITE_TOKEN is not set in this environment.' };
  }

  const uploadedAt = args.nowIso ?? new Date().toISOString();
  const out: KYCFile[] = [];
  try {
    for (const f of files) {
      const path = kycBlobPath(workspaceId, personId, documentType, f.type);
      const blob = await put(path, f, { access: 'public', contentType: f.type, addRandomSuffix: false });
      out.push({ url: blob.url, mime_type: f.type, filename: f.name, size_bytes: f.size, uploaded_at: uploadedAt });
    }
  } catch (err) {
    console.error('[kyc_upload] blob upload failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    // A token error can still surface here (e.g. an invalid/expired token that
    // passed the presence check above) — classify it distinctly from a genuine
    // upload failure so Accounts knows whether to check config vs retry.
    const isToken = /token/i.test(msg);
    return { ok: false, error: isToken ? 'blob_token_missing' : 'blob_upload_failed', detail: msg };
  }
  return { ok: true, files: out };
}
