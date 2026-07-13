// ============================================================================
// src/lib/gst.ts  (Sub-turn 13, chunk 5)
// ----------------------------------------------------------------------------
// Indian GST state resolution. The CGST/SGST-vs-IGST split is decided by
// comparing the customer's state CODE to the workspace's — never by a hand-set
// tax profile (Booqable's model, which for India means 37 profiles assigned by
// hand and a wrong invoice one misclick away).
//
// Deriving the customer's state code, in priority order:
//   1. GSTIN present → the leading 2 digits ARE the state (authoritative). A
//      B2B customer claims input credit; a wrong split breaks THEIR return too,
//      so the GSTIN wins over any address.
//   2. an explicit state_code
//   3. the address state name
//   4. none → the caller assumes the workspace state (intra-state) and MUST
//      flag state_assumed = true and block-with-confirm before finalising.
//
// Money/tax never touches a float — rate is basis points, split is integer paise.
// ============================================================================

// GSTIN leading 2-digit state code → 2-letter code.
const GST_NUM_TO_CODE: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR',
  '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK', '12': 'AR',
  '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS',
  '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ',
  '25': 'DD', '26': 'DN', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA',
  '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TG',
  '37': 'AP', '38': 'LA',
};

// Common state-name → 2-letter code (lowercased keys). Enough for B2C address
// fallback; add as needed.
const STATE_NAME_TO_CODE: Record<string, string> = {
  'gujarat': 'GJ', 'maharashtra': 'MH', 'rajasthan': 'RJ', 'delhi': 'DL',
  'karnataka': 'KA', 'tamil nadu': 'TN', 'telangana': 'TG', 'kerala': 'KL',
  'uttar pradesh': 'UP', 'madhya pradesh': 'MP', 'west bengal': 'WB',
  'punjab': 'PB', 'haryana': 'HR', 'bihar': 'BR', 'odisha': 'OD',
  'chhattisgarh': 'CG', 'jharkhand': 'JH', 'assam': 'AS', 'goa': 'GA',
  'andhra pradesh': 'AP', 'uttarakhand': 'UK', 'himachal pradesh': 'HP',
};

/** Map a workspace/customer state NAME to a code (for the legacy name path). */
export function stateNameToCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase(); // already a code
  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

/** Derive a customer's GST state code. Returns null when nothing resolves — the
 *  caller then assumes the workspace state and sets state_assumed. */
export function deriveGstStateCode(args: {
  gstin?: string | null;
  stateCode?: string | null;
  stateName?: string | null;
}): string | null {
  const gstin = (args.gstin ?? '').trim();
  if (gstin.length >= 2 && /^\d{2}/.test(gstin)) {
    const code = GST_NUM_TO_CODE[gstin.slice(0, 2)];
    if (code) return code;
  }
  if (args.stateCode && /^[A-Za-z]{2}$/.test(args.stateCode.trim())) {
    return args.stateCode.trim().toUpperCase();
  }
  return stateNameToCode(args.stateName);
}

export type GstResolution = {
  customerCode: string | null;   // null = could not resolve
  workspaceCode: string | null;
  isIntraState: boolean;         // when assumed, true (assumes workspace state)
  stateAssumed: boolean;         // true when the customer state had to be assumed
};

/** Resolve the split basis for an order. */
export function resolveGst(args: {
  gstin?: string | null;
  customerStateCode?: string | null;
  customerStateName?: string | null;
  workspaceStateCode: string | null;
}): GstResolution {
  const customerCode = deriveGstStateCode({
    gstin: args.gstin,
    stateCode: args.customerStateCode,
    stateName: args.customerStateName,
  });
  const workspaceCode = args.workspaceStateCode
    ? args.workspaceStateCode.trim().toUpperCase()
    : null;
  const stateAssumed = customerCode === null;
  // When assumed, treat as intra-state (workspace state). The block-with-confirm
  // gate at invoice finalisation forces a human decision before it's frozen.
  const effective = customerCode ?? workspaceCode;
  const isIntraState = effective !== null && workspaceCode !== null && effective === workspaceCode;
  return { customerCode, workspaceCode, isIntraState, stateAssumed };
}

/** Per-line GST split in basis points. Intra → CGST+SGST (each ~half, remainder
 *  absorbs the rounding); inter → IGST. Integer paise throughout — no floats. */
export function splitGstBps(basePaise: number, rateBps: number, isIntraState: boolean):
  { cgst_paise: number; sgst_paise: number; igst_paise: number } {
  const zero = { cgst_paise: 0, sgst_paise: 0, igst_paise: 0 };
  if (basePaise <= 0 || rateBps <= 0) return zero;
  const total = Math.floor((basePaise * rateBps) / 10000);
  if (isIntraState) {
    const cgst = Math.floor((basePaise * rateBps) / 20000);
    return { cgst_paise: cgst, sgst_paise: total - cgst, igst_paise: 0 };
  }
  return { cgst_paise: 0, sgst_paise: 0, igst_paise: total };
}
