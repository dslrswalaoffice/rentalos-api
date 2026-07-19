# RentalOS Constitution

**Purpose:** Authoritative reference for architectural decisions, product patterns, and design language. Every proposal — feature spec, code slice, design brief — must pre-check against the 9 Alignment Gates in Section 3 before implementation.

**Standing rule:** New patterns require proof that existing patterns cannot solve the problem. Reuse is default. Invention is last resort.

---

## Section 1 — Product Vision

RentalOS is an Operations Intelligence Platform for rental businesses. Initially built for DSLRSWALA (camera + AV rental, Vadodara). Productized as multi-tenant SaaS in Phase 2.

**Not an ERP.** Not a CRUD app. Not booking software. An operational command center for the daily work of running a rental business.

**Design target:** Linear, Notion, Apple, Shopify Admin, Stripe Dashboard. Never Booqable, SAP, Odoo, or any ERP-styled interface.

**Anti-vision:** feature overload, ERP tabs, excessive navigation, hardcoded per-tenant behavior, backend-only PRs without frontend verification, delete-everything-and-start-fresh when facing specific fixable errors.

---

## Section 2 — 10 Core Principles

1. Workflow before features
2. Simplicity over complexity
3. Operations before reporting
4. Prevent human error instead of fixing it
5. Progressive disclosure
6. Configuration over hardcoded behavior (all per-tenant rules in `workspaces.settings` JSONB)
7. Mobile-first operations (Ruhan/Shoaib use phones constantly)
8. API-first architecture
9. Build reusable systems instead of isolated features
10. Ship progressively and improve continuously

---

## Section 3 — The 9 Alignment Gates

Every proposal must pass all 9 before implementation begins.

### Gate 1: Business Object architecture
Does this fit existing entities (People, Assets, Order, Quote, Dispatch, Return, Inspection, Damage Incident, Substitution, Standby, Extension, Cancellation, Deposit Hold, Invoice, Payment, Refund, Maintenance Job)? Or is it inventing a new entity where a role classifier / status column / event type on an existing entity would do?

**Fail = STOP.** Adding new entities without exhausting existing ones is the #1 source of schema debt.

### Gate 2: Lifecycle-first design
Does this have explicit lifecycle states, transitions, terminal states, and event emissions? Or is it a stateless CRUD blob?

Every business object has a lifecycle. Every state transition emits an event to the object's `_events` table. No exceptions.

### Gate 3: Shared Platform Services
Does this reuse existing services (Notification System / Approval Routing / Idempotency / Audit / Adapter interfaces / Attention Engine / Timeline Engine / Smart Preview / Blocked Action)? Or is it spinning up parallel infrastructure?

**Fail = STOP.** Parallel infrastructure means future maintenance across two systems doing the same thing.

### Gate 4: Timeline Engine
Does every mutation emit an event to the object's `_events` table per Item 13 pattern? Silent state changes are forbidden.

Audit trail is a regulatory floor. Also makes disputes defensible.

### Gate 5: Attention Engine
Does this surface issues through existing attention rules (Smart Preview hints, list left-border colors, Notifications Tray)? Or is it inventing a new alerting mechanism?

Users have a single mental model for "something needs attention." Don't fork it.

### Gate 6: Operations-first workflow
Does this help someone DO something today? Or is it a reporting/analytics feature masquerading as operational?

Operations before insights. Insights inform operations, not the other way around.

### Gate 7: Progressive disclosure
Does this hide complexity until needed (Smart Preview → collapsed cards → expanded on interaction)? Or does it dump everything on screen?

Cognitive load is the enemy. Show what matters. Reveal on demand.

### Gate 8: Design System
Does this use locked palette (4-color family), structural anchors (64px + `#26235a` icon rail Cool Navy OR 60px + `#faf9f7` icon rail Warm Cream, 60/56px top-bar respectively, 14px card radius), Item 10 pill vocabulary, Item 12 Blocked Action pattern? Or is it inventing new visual language?

**Fail = STOP.** Portal Theming (Item DS-25) makes both theme families valid — but no new palette, no new structural dimensions, no new interaction pattern without proof.

### Gate 9: Existing navigation structure
Does this fit into the 8-module sidebar (Dashboard · Orders · Assets · People · Finance · Insights · Communications · System)? Or is it demanding a new module?

New modules are never approved without displacing an existing one. Sidebar is a scarce resource.

---

## Section 4 — Gate for New Patterns

If a proposal genuinely needs a new pattern, prove:

- **Why existing patterns fail.** Which specific Item (9-N1) was tried and why it doesn't fit this problem.
- **Concrete counterexamples.** At least 3 attempts to solve with existing patterns and why each fails.
- **Impact of new pattern.** What existing surfaces would need to adopt this pattern for consistency (new patterns aren't isolated — they propagate).

Only after that proof does the new pattern proceed. Flag as "candidate pattern, review before adopting into constitution" — not automatic acceptance.

---

## Section 5 — Item Pattern Library (Universal Reference)

### Component patterns (Items 9-14)
- **Item 9** · Lifecycle Stepper — every 360 workspace opens with visual state stepper
- **Item 10** · Status Pills — 4-color-family vocabulary mapped to lifecycle states
- **Item 11** · Smart Preview — 5-block hover preview on list rows
- **Item 12** · Blocked Action — every unavailable action visible with reason (never hide, always explain)
- **Item 13** · Timeline — unified activity feed inside every 360
- **Item 14** · OTP Handover — 6-step mobile-first physical handover flow

### Screen patterns (Items 15-24)
- **Item 15** · List — 7-region shell (Orders/People/Assets/Finance/KYC/Maintenance all use this)
- **Item 16** · 360 Workspace — 5-region shell (Order/Person/Damage/Deposit 360 all use this)
- **Item 17-18** · Empty States — Fresh/Filtered/Cleared three-category pattern
- **Item 19-20** · Dispatch UI + Return UI — mobile-first capture flows
- **Item 21-22** · Extension Modal + Cancellation Modal — 720px preview-before-commit pattern
- **Item P1-P2** · People List + Person 360
- **Item A1** · Asset List / Inventory Workspace

### Contract patterns (Items 25-28)
- **Item 25** · API — POST lifecycle actions with named endpoints (not PATCH for state transitions), heavy 360 payloads, cursor pagination, HTTP 403 for permission and policy blocks
- **Item 26** · DB — BIGINT paise, UUID v7, workspace_id second column, CHECK constraints not enums, json_agg not array_agg (Neon HTTP driver quirk), immutable financial records, append-only event tables per object, workspace-scoped at repository layer
- **Item 27** · Permission Matrix — 5 roles (Owner/Manager/Warehouse/Sales/Accounts), 6-layer model (Module→Entity→Action→Lifecycle→Field→DataScope), warehouse NEVER sees costs
- **Item 28** · Idempotency — UUID v4 Idempotency-Key header on all mutation endpoints

### Cross-cutting patterns (Item N1)
- **Item N1** · Notification System — 4 trigger modes (auto/auto_with_review/manual_only/off), 30+ event vocabulary, adapter-based multi-channel delivery, opt-in compliance regulatory floor

---

## Section 6 — Terminology (Production Code Source of Truth)

**People** (not Customers) — one entity, multiple relationship types via `person_roles` classifier (customer/freelancer/partner/vendor/investor)

**Assets** (not Inventory) — one master table, `asset_type` classifier (rental/operational/infrastructure/vehicle)

**System** (not Settings) — sidebar module for workspace configuration

**Order** — lifecycle container for the entire rental transaction

45 Sprint 1 mockup files use old terminology (Customers/Inventory/Settings) — kept as historical documentation. Production code uses new terminology from ONE source of truth (shared sidebar component).

---

## Section 7 — Design Language

### Palette (soft-locked, family-based)

**4 signal color families** — hex variants within family accepted:
- Indigo (primary): Cool Navy `#4148c9` / Warm Cream `#4f46e5`
- Green (success): `#059669` / `#16a34a`
- Amber (warning): `#d97706` / `#d98314`
- Red (danger): `#dc2626` / `#dc2f34`

**Two neutral families** — do NOT mix within one file:
- Cool Blue-Tinted (operational surfaces)
- Warm Brown-Tinted (System sub-pages)

**Portal Theming (Item DS-25)** swaps at runtime via CSS variables. Cool Navy (default) + Warm Cream + Dark Mode v1.1.

**Retired:** `#2f6bed` (old progress blue). Zero purple/orange/violet/magenta/tomato anywhere.

### Structural anchors — STRICT

Cool Navy theme:
- Icon rail: 64px wide, `#26235a` background
- Top-bar: 60px tall

Warm Cream theme:
- Icon rail: 60px wide, `#faf9f7` background
- Top-bar: 56px tall

Both themes:
- Card radius: 14px
- Save-bar language: `Discard` (not `Cancel` — reserved for modal dismiss)

### Typography (locked)
- Space Grotesk (400-700) — display, headers
- Manrope (400-700) — body, form fields
- JetBrains Mono (400-600) — numbers, timestamps, reference IDs (INV-2026-0142, BK2214, etc.)

---

## Section 8 — Business Object Model

### People (master entity)
- One table, multiple relationship types via `person_roles` classifier
- Roles: customer, staff, investor, vendor, freelancer, partner
- Lifecycle: Lead → First Rental → Repeat → VIP (based on `tier` column)
- Trust score computed from behavior signals (payment reliability, damage history, KYC completeness)

### Assets (master entity)
- One master table with `asset_type` classifier
- Types: rental, operational, infrastructure, vehicle
- Sprint 1 focus stays on rental assets (95%+ of daily use)
- Products layer only for rental assets (SKU concept doesn't apply uniformly)

### Order (lifecycle container)
Rich event object model:
- Quote versions (immutable snapshots, own table)
- Order (main record with aggregate_status derived)
- Line items with per-line micro-lifecycle
- Dispatches (multiple per order supported)
- Returns (multiple per order supported)
- Inspections (own table, triggers maintenance if fail)
- Extensions (first-class table, not inline edit)
- Cancellations (first-class table with 3-tier state matrix)
- Damage Incidents (parallel workflow, own table)
- Substitutions (first-class swap events preserving relationship)
- Standby (timed soft reservation parallel to Quote)
- Deposit Holds (first-class object with full event table)

Every event emits to object-specific `_events` table.

### Financial (immutable records)
- Invoices (immutable once sent)
- Payments (append-only)
- Refunds (append-only)
- Deposits (event-log pattern)

Never mutate financial records. Correct via new records (credit notes, reversals).

---

## Section 9 — Non-Negotiable Architecture Rules

### Data
- BIGINT paise for all monetary values (`_paise` suffix, no float)
- UUID v7 primary keys everywhere
- `workspace_id` as second column on every operational table
- CHECK constraints, not native enum types (easier to extend)
- Cursor-based pagination

### Queries (Neon HTTP driver)
- Use `json_agg`, never `array_agg` (returns text like `{customer}`)
- `SELECT FOR UPDATE` for availability checks
- Advisory locks for invoice number generation

### Migrations
- Every `ADD CONSTRAINT` preceded in same migration by data fix that makes it satisfiable
- Wrap in `sql.transaction()` with fallback for transaction-hostile statements
- Sequential numbering via `schema_migrations` ledger

### Mutations
- Every mutation emits audit event to object-specific `_events` table
- Enforced at repository layer, not application layer

### Configuration
- Every rule that varies per rental house lives in `workspaces.settings` JSONB
- Never hardcode DSLRSWALA-specific rules
- Third-party providers via adapter interface (WhatsApp/Email/SMS/Payment)

### PR workflow
- Backend + frontend ship together in single PR
- Aamir verifies via real UI clicks
- Backend-only PR = anti-pattern
- Max ~8 files per PR

### Testing (Rule A-F)
- A: Contract test per endpoint (real Zod schema)
- B: Real DB round-trip per mutation
- C: Merge field completeness
- D: Configurability test (change workspaces.settings, verify UI reflects)
- E: Backward compatibility test (new feature renders for entities created before feature shipped)
- F: End-to-end click test for critical flows

---

## Section 10 — Anti-Over-Engineering Rules (per mentor Nov 2025)

Every Claude Code slice must enforce:

1. **Grep existing codebase first.** Before writing any function, check if it already exists.
2. **No new npm dependencies without approval + 2 alternatives considered.**
3. **No new abstractions without 3 concrete implementations that would benefit.** No preemptive base classes, interfaces, adapters, utility modules.
4. **Max ~8 files touched per PR.** Larger = split.
5. **Prefer boring over clever.** Use Postgres + Redis. NO Kafka, SQS, event queues, background job frameworks until Phase 2.
6. **No new services or infrastructure without approval.** No new S3 buckets, CDN configs, worker processes, message queues, third-party services.

Duplication is a code review reject. Over-engineering is a code review reject.

---

## Section 11 — Slice Sequence (locked, do NOT reorder without discussion)

Post-mentor-input Jul 18 2026 sequence, ~2 weeks per slice, ~5 months to Slice 10:

- **Slice 1** — Orders List displays real workspace orders + basic search/filter
- **Slice 2** — New Order Composer wired end-to-end
- **Slice 3** — Order 360 read-only view
- **Slice 4** — Dispatch flow with photos + OTP + signature per Item 14
- **Slice 5** — Return + basic inspection routing
- **Slice 6** — GST invoice PDF generation
- **Slice 7** — Payment recording + basic reconciliation
- **Slice 8** — KYC review workflow per DS-18 substrate
- **Slice 9** — Communications module wire-up per DS-26 substrate
- **Slice 10** — Notifications firing per Item N1

After Slice 10: extensions, cancellations, damage, substitution, standby, maintenance, reporting, dashboard, analytics.

---

## Section 12 — Phase 2 Deferrals (NOT in v1)

Documented for future reference, do NOT build in v1:

- Kafka / SQS / event queues / async architecture (Postgres + Redis handles ~250 tx/day fine)
- Multi-region deployment
- Analytics beyond basic Financial Reports
- Portal customization for SaaS tenants beyond 3 preset themes
- AI recommendations / chatbot / voice
- Broadcast marketing campaigns (Communications inbox in v1, campaigns not)
- Custom color themes beyond 3 presets
- Dark Mode (v1.1)
- Customer self-service portal
- Template editor beyond basic Merge Fields
- Automated reply / chatbot AI
- Email HTML rich rendering (plain text v1)
- Notification snooze until date (fixed 1hr v1)
- Voice call recording
- Video call scheduling

---

## Section 13 — Phase 3 Deferrals (Never in current roadmap)

- Cross-tenant analytics
- White-label branding beyond preset themes
- Advanced role permissions beyond 5 locked roles
- Level 3 custom accent color theming
- Level 4 full palette override

---

## Section 14 — Real-User Testing Rule

**Ruhan (Warehouse) + Shoaib (Manager) are the primary QA surface.** Their daily operational use catches bugs synthetic testing misses. Whatever ships as a slice becomes their tool immediately.

Every slice shipped must be in front of them the same week. Their feedback after 5 real bookings is worth more than 10 more design briefs.

If a design or code decision doesn't help them do their real work, deprioritize it.

---

## Section 15 — Self-Review Checklist (before any proposal)

Before answering any question or writing any prompt, run this internal check:

- ❌ Duplicate features
- ❌ Duplicate modules
- ❌ New UI patterns (require Section 4 proof if introducing)
- ❌ Inconsistent naming
- ❌ Violating existing principles
- ❌ Unnecessary complexity
- ❌ Screen-level thinking instead of product-level thinking
- ❌ "Quick implementation" optimization instead of 10-year optimization

If any check fails, revise the proposal before delivering.

---

## Section 16 — Continuous Improvement Directive

Whenever noticing:
- Repeated patterns
- Repeated code
- Repeated workflows
- Repeated UI
- Repeated business logic

**STOP.**

Propose extracting into:
- Shared Component
- Shared Platform Service
- Business Engine
- Workflow
- Design Pattern

Always optimize the product itself before implementing another feature.

---

**End of Constitution.**

Reference this document at start of every Claude Code session alongside CLAUDE.md. Every proposal pre-checks against Sections 3, 4, 9, 10, 15.
