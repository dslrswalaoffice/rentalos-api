// ============================================================================
// src/lib/blocked_action.ts (Slice 1) — structured Blocked Action errors
// ----------------------------------------------------------------------------
// Blocked actions must EXPLAIN themselves (Item 12), not return a silent 403.
// A blocked mutation returns:
//   { error: { code, message, reasons: [ { category, code, message, severity,
//              fix_link_type?, fix_link_target? } ] } }
// The frontend renders reasons[] as the Blocker Panel. Categories map to a fixed
// severity colour so the UI never invents one.
// ============================================================================

// 9 blocker categories (Item 12) → severity colour.
export type BlockCategory =
  | 'permission'        // red
  | 'lifecycle_state'   // amber
  | 'data_prerequisite' // amber
  | 'time_constraint'   // neutral
  | 'availability'      // amber
  | 'approval_pending'  // amber
  | 'policy'            // amber
  | 'terminal_state'    // red
  | 'external';         // neutral

export type BlockSeverity = 'red' | 'amber' | 'neutral';

const CATEGORY_SEVERITY: Record<BlockCategory, BlockSeverity> = {
  permission: 'red',
  lifecycle_state: 'amber',
  data_prerequisite: 'amber',
  time_constraint: 'neutral',
  availability: 'amber',
  approval_pending: 'amber',
  policy: 'amber',
  terminal_state: 'red',
  external: 'neutral',
};

export type BlockReason = {
  category: BlockCategory;
  code: string;
  message: string;
  severity: BlockSeverity;
  fix_link_type?: 'internal' | 'external' | null;
  fix_link_target?: string | null;
};

export type BlockedErrorBody = {
  error: {
    code: string;
    message: string;
    reasons: BlockReason[];
  };
};

/** Build one reason, filling severity from the category. */
export function reason(
  category: BlockCategory,
  code: string,
  message: string,
  fix?: { type: 'internal' | 'external'; target: string },
): BlockReason {
  return {
    category,
    code,
    message,
    severity: CATEGORY_SEVERITY[category],
    fix_link_type: fix?.type ?? null,
    fix_link_target: fix?.target ?? null,
  };
}

/** Build the structured error body for a blocked action. */
export function orderBlock(code: string, message: string, reasons: BlockReason[]): BlockedErrorBody {
  return { error: { code, message, reasons } };
}

// Recommended HTTP status per Item 25: 403 for policy/permission/lifecycle blocks,
// 409 for terminal-state conflicts, 422 for prerequisite/validation. The caller
// passes the status explicitly so intent stays visible at the call site.
