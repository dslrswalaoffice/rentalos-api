-- ============================================================================
-- Migration 025 — Analytics performance indexes (Sub-turn 7)
-- ============================================================================
-- Additive only. No column or data changes. These speed up the on-demand
-- analytics queries in src/lib/analytics.ts (range scans on rental_start,
-- rental line-item lookups, and per-customer aggregation).
-- ============================================================================

-- Range queries filter orders by (workspace, status) and scan rental_start.
CREATE INDEX IF NOT EXISTS orders_workspace_status_rental_start_idx
  ON orders (workspace_id, status, rental_start DESC)
  WHERE deleted_at IS NULL;

-- Revenue / utilization join order_items by order and filter item_type.
CREATE INDEX IF NOT EXISTS order_items_workspace_order_type_idx
  ON order_items (workspace_id, order_id, item_type);

-- Customer analytics groups orders by customer + status.
CREATE INDEX IF NOT EXISTS orders_workspace_customer_status_idx
  ON orders (workspace_id, customer_person_id, status)
  WHERE deleted_at IS NULL;
