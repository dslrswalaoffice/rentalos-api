-- ============================================================================
-- 003_people.sql · People (customers, staff, investors, vendors)
-- ============================================================================
-- One row per person, many roles. A person can be customer + investor
-- simultaneously (common at DSLRSWALA — regular renter who invested).
--
-- Phone is treated as de-facto primary key within a workspace since it's the
-- WhatsApp/OTP channel. UNIQUE(workspace_id, phone) prevents duplicates.
--
-- ID proof stored as text only for MVP. Image upload deferred to Orders
-- module (when we wire Vercel Blob storage for handover verification).
-- ============================================================================

CREATE TYPE person_role AS ENUM ('customer', 'staff', 'investor', 'vendor');

-- ----------------------------------------------------------------------------
-- people — one row per human
-- ----------------------------------------------------------------------------
CREATE TABLE people (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  display_name        text          NOT NULL,
  phone               text          NOT NULL,          -- store as user typed; validation loose for MVP
  phone_verified_at   timestamptz,                     -- set when OTP handover succeeds
  email               citext,

  -- ID proof: text-only for MVP. When Orders module adds handover flow,
  -- we'll add id_proof_image_url + verification metadata.
  id_proof_type       text,                            -- 'aadhaar' | 'pan' | 'driving_license' | 'passport'
  id_proof_number     text,

  -- Address (all optional; delivery orders will require city minimum)
  address_line        text,
  city                text,
  state               text,
  postal_code         text,
  country_code        text          NOT NULL DEFAULT 'IN',

  -- B2B / GSTIN. Both nullable — most rentals are B2C.
  company_name        text,
  gstin               text,

  notes               text,                            -- internal only, never shown to customer

  created_by          uuid          REFERENCES users(id),
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  UNIQUE (workspace_id, phone)
);

COMMENT ON TABLE people IS 'Customers, staff, investors, vendors — all humans. Type via person_roles.';
COMMENT ON COLUMN people.phone IS 'De-facto primary key in India — WhatsApp and OTP channel.';

CREATE INDEX idx_people_workspace_name
  ON people(workspace_id, display_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_people_workspace_phone
  ON people(workspace_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_people_workspace_email
  ON people(workspace_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX idx_people_workspace_company
  ON people(workspace_id, company_name) WHERE deleted_at IS NULL AND company_name IS NOT NULL;

-- ----------------------------------------------------------------------------
-- person_roles — many-to-many. A person can be customer + investor + vendor.
-- ----------------------------------------------------------------------------
CREATE TABLE person_roles (
  person_id      uuid           NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  workspace_id   uuid           NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role           person_role    NOT NULL,
  is_active      boolean        NOT NULL DEFAULT true,
  added_at       timestamptz    NOT NULL DEFAULT now(),
  added_by       uuid           REFERENCES users(id),
  deactivated_at timestamptz,

  PRIMARY KEY (person_id, role)
);

CREATE INDEX idx_person_roles_workspace_role
  ON person_roles(workspace_id, role) WHERE is_active = true;
CREATE INDEX idx_person_roles_person
  ON person_roles(person_id) WHERE is_active = true;

-- ----------------------------------------------------------------------------
-- Auto-bump updated_at on people (function defined in 002_inventory.sql)
-- ----------------------------------------------------------------------------
CREATE TRIGGER people_bump_updated_at BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();
