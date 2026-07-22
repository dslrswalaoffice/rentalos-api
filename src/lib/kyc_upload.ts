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
  | { ok: false; error: string; detail?: unknown };

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
  if (!files.length) return { ok: false, error: 'no_files' };
  if (files.length > KYC_MAX_FILES) return { ok: false, error: 'too_many_files', detail: { max: KYC_MAX_FILES, got: files.length } };

  for (const f of files) {
    if (!(KYC_ALLOWED_TYPES as readonly string[]).includes(f.type)) {
      return { ok: false, error: 'invalid_file_type', detail: { filename: f.name, type: f.type, allowed: KYC_ALLOWED_TYPES } };
    }
    if (f.size > KYC_MAX_BYTES) {
      return { ok: false, error: 'file_too_large', detail: { filename: f.name, size: f.size, max: KYC_MAX_BYTES } };
    }
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
    return { ok: false, error: 'upload_failed', detail: String(err) };
  }
  return { ok: true, files: out };
}
