-- 046_create_substitutions.sql — Sub-slice 2.3: first-class asset substitution (Item 5).
-- ---------------------------------------------------------------------------
-- NUMBERING: the handoff pack calls this "054", but on main the latest migration
-- is 045 (quote_versions). Migrations are matched by filename and must be
-- monotonic, so substitutions = 046 (NOT 054). The pack's 054-061 numbers are
-- aspirational; the real next-available sequence is 046-053. Same renumber
-- discipline as migration 044 (pack "043" → real 044).
--
-- TABLE-NAME REALITY: the handoff pack schema references `order_line_items`
-- throughout. That table does NOT exist — the real table is `order_items`
-- (migration 004). Every FK here targets `order_items(id)`.
--
-- A substitution is a first-class swap event: an asset/line needs replacement at
-- any point in an order's lifecycle (pre-dispatch failure, unavailable at
-- dispatch, mid-rental damage, customer up/downgrade, extension conflict). The
-- original line is NEVER deleted — it goes to order_items.status =
-- 'substituted_out' (added in migration 047) so the audit chain is preserved.
-- The replacement is a NEW order_items line. Chain swaps (A→B→C) each get their
-- own row with parent linkage via source_id when source_type = 'direct' isn't
-- enough (the chain is reconstructable from original/replacement line refs).
--
-- Discipline: gen_random_uuid() (v4), workspace_id 2nd column NOT NULL,
-- policy_applied_snapshot frozen at creation for audit.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS substitutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id),
  substitution_number TEXT NOT NULL,                       -- SUB-2026-0142-01

  -- Source (what triggered this substitution)
  source_type TEXT NOT NULL CHECK (source_type IN (
    'direct',                -- staff-initiated
    'damage_incident',       -- from a Save The Shoot flow
    'extension_conflict',    -- from Extension modal conflict resolution
    'pre_dispatch_check',    -- unit failed pre-dispatch inspection
    'customer_request'       -- Phase 2, portal-initiated
  )),
  source_id UUID,                                          -- FK-ish to damage_incidents/order_extensions/etc (soft link)

  -- 7-tag substitution type taxonomy
  substitution_type TEXT NOT NULL CHECK (substitution_type IN (
    'same_unit_swap',
    'same_product_swap',
    'equivalent_product_swap',
    'upgrade_free',
    'upgrade_paid',
    'downgrade_credit',
    'kit_component_swap'
  )),

  -- 11-tag reason taxonomy
  substitution_reason_tag TEXT NOT NULL CHECK (substitution_reason_tag IN (
    'unit_failed_precheck',
    'unit_unavailable_at_dispatch',
    'unit_damaged_in_rental',
    'customer_preference_change',
    'customer_upgrade_request',
    'goodwill_upgrade',
    'product_shortage',
    'extension_conflict',
    'operational_convenience',
    'staff_error',
    'other'
  )),
  substitution_reason_notes TEXT,

  -- Original + replacement item references (order_items, NOT order_line_items)
  original_order_item_id UUID NOT NULL REFERENCES order_items(id),
  original_asset_id UUID REFERENCES assets(id),
  replacement_order_item_id UUID REFERENCES order_items(id),
  replacement_asset_id UUID REFERENCES assets(id),
  -- Preserve the original item's pre-substitution status so revert can restore it.
  original_prior_status TEXT,

  -- Financial handling
  financial_handling TEXT NOT NULL CHECK (financial_handling IN (
    'no_change',
    'additional_charge',
    'credit_to_customer',
    'business_absorb'
  )),
  financial_amount_paise BIGINT NOT NULL DEFAULT 0,
  pro_rated_days INTEGER,                                  -- for mid-rental swaps

  -- Timing
  timing TEXT NOT NULL CHECK (timing IN (
    'immediate_before_dispatch',
    'rush_mid_rental',
    'at_next_natural_handover',
    'scheduled'
  )),
  scheduled_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,

  -- Linked events (created after substitution executes)
  linked_return_event_id UUID,                             -- Return event for the original
  linked_dispatch_event_id UUID,                           -- Dispatch event for the replacement

  -- Status lifecycle
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed',
    'pending_approval',
    'approved',
    'rejected',
    'executed',
    'reverted'
  )),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_request_id UUID REFERENCES approval_requests(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,

  -- Reversion (configurable undo window; default 24hr via substitution_policy)
  reverted_at TIMESTAMPTZ,
  reverted_reason TEXT,
  reverted_by UUID REFERENCES users(id),

  -- Customer notification
  customer_notified BOOLEAN NOT NULL DEFAULT FALSE,
  customer_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,

  -- Audit
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Policy snapshot (frozen at creation for audit — e.g. reversion_window_hours)
  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_substitutions_workspace_status ON substitutions (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_substitutions_order ON substitutions (order_id);
CREATE INDEX IF NOT EXISTS idx_substitutions_source ON substitutions (source_type, source_id);
-- Uniqueness of the human-readable number per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_substitutions_number_per_ws ON substitutions (workspace_id, substitution_number);

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   DROP TABLE IF EXISTS substitutions;
-- ---------------------------------------------------------------------------
