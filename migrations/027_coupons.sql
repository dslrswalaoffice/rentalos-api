-- ============================================================================
-- Migration 027 — Coupons / discount codes (Sub-turn 8b)
-- ============================================================================
-- Two tables: coupons (definitions) + coupon_redemptions (per-order usage).
-- NOTE: order_items.item_type is the `order_item_type` enum which ALREADY has a
-- 'discount' value (migration 004), so no enum change is needed — the discount
-- is stored as an order_items row with item_type='discount' and a negative
-- total, flowing through the existing pricing/invoice/revision engine.
-- ============================================================================

CREATE TABLE IF NOT EXISTS coupons (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  code                  text        NOT NULL,                      -- UPPERCASE, unique per workspace
  description           text,                                      -- internal note ("Diwali 2026 promo")

  discount_type         text        NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value        bigint      NOT NULL CHECK (discount_value > 0),  -- pct: 1-100; fixed: paise
  max_discount_paise    bigint,                                    -- cap for percentage (null = uncapped)

  min_order_paise       bigint      NOT NULL DEFAULT 0 CHECK (min_order_paise >= 0),

  valid_from            timestamptz,                               -- null = no lower bound
  valid_until           timestamptz,                               -- null = no upper bound

  max_uses_total        integer,                                   -- null = unlimited
  max_uses_per_customer integer,                                   -- null = unlimited

  is_active             boolean     NOT NULL DEFAULT true,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid        REFERENCES users(id),

  UNIQUE (workspace_id, code),
  CHECK (discount_type = 'fixed' OR discount_value <= 100)
);

CREATE INDEX IF NOT EXISTS coupons_workspace_active_idx
  ON coupons (workspace_id, is_active, code);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  coupon_id               uuid        NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  order_id                uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_person_id      uuid        REFERENCES people(id) ON DELETE SET NULL,

  discount_paise_applied  bigint      NOT NULL,   -- actual discount at apply time (audit snapshot)
  subtotal_at_apply_paise bigint      NOT NULL,   -- subtotal at apply time (audit snapshot)

  applied_at              timestamptz NOT NULL DEFAULT now(),
  applied_by_user_id      uuid        REFERENCES users(id),
  removed_at              timestamptz,            -- null = still active
  removed_by_user_id      uuid        REFERENCES users(id)
);

-- One ACTIVE coupon per order (v1). Removed redemptions keep their row for audit.
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_one_active_per_order
  ON coupon_redemptions (order_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS coupon_redemptions_coupon_idx
  ON coupon_redemptions (workspace_id, coupon_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS coupon_redemptions_customer_idx
  ON coupon_redemptions (workspace_id, customer_person_id, coupon_id)
  WHERE removed_at IS NULL;
