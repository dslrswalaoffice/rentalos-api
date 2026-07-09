-- ============================================================================
-- Migration 011 — Workspace settings structure + structured address columns
-- ============================================================================
-- Sub-turn 4a moves settings management from raw SQL into a product UI. This
-- migration (a) adds structured address columns the settings form edits, and
-- (b) ensures workspace.settings has every expected sub-object present.
--
-- (Numbered 011 — 010 is the return-metadata migration. Ledger matches on
-- filename.)
--
-- The settings enrichment is ADDITIVE: it starts from the existing settings and
-- only fills a sub-object when missing (COALESCE(existing, default)). This
-- preserves any keys not listed here — notably the legacy `deposit` object from
-- migration 004 — instead of clobbering them. DSLRSWALA's place_of_supply and
-- gst_split_cgst_sgst_igst:true live outside/inside this JSONB and stay intact.
-- ============================================================================

-- Structured address (the invoice snapshot still reads business_address; the
-- settings PATCH recomposes it from these parts on save).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city          text,
  ADD COLUMN IF NOT EXISTS state         text,
  ADD COLUMN IF NOT EXISTS postal_code   text;

UPDATE workspaces
SET settings =
  COALESCE(settings, '{}'::jsonb)
  || jsonb_build_object('billing', COALESCE(settings->'billing', jsonb_build_object(
       'rounding_rule', '24_hour_windows',
       'grace_period_hours', 0,
       'minimum_days', 1
     )))
  || jsonb_build_object('tax', COALESCE(settings->'tax', jsonb_build_object(
       'default_gst_percent', 18,
       'charge_gst_by_default', false
     )))
  || jsonb_build_object('invoice', COALESCE(settings->'invoice', '{}'::jsonb) || jsonb_build_object(
       'number_format',    COALESCE(settings->'invoice'->>'number_format', 'YYYY-MM-DD-{order}-{seq}-R{rev}'),
       'terms',            COALESCE(settings->'invoice'->>'terms', 'Payment due within 15 days of invoice date. Late payment attracts interest at 24% p.a.'),
       'default_due_days', COALESCE((settings->'invoice'->>'default_due_days')::int, 15)
     ))
  || jsonb_build_object('bank_details', COALESCE(settings->'bank_details', jsonb_build_object(
       'account_name', null,
       'bank_name', null,
       'account_number', null,
       'ifsc', null,
       'branch', null,
       'upi_id', null
     )))
  || jsonb_build_object('features', COALESCE(settings->'features', jsonb_build_object(
       'qr_scanning', false,
       'otp_handover', false,
       'customer_tiers', false,
       'vip_consolidated_billing', false,
       'trust_score', false,
       'investor_module', false,
       'cashfree_gateway', false,
       'wati_notifications', false,
       'gst_split_cgst_sgst_igst', false,
       'damage_module', false,
       'auto_close_when_all_items_terminal', false
     )));
