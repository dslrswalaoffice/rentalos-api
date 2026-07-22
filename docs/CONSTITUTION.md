# RentalOS Constitution

*The durable principles behind RentalOS. Product docs describe **what** we build;
this describes **how we think** so that every slice compounds into a platform
rather than accreting into a pile of features. Aamir's framework, Jul 20 2026.*

> **Core principle:** **Everything should become a reusable capability before it
> becomes a feature.** A feature serves one screen; a capability serves every
> future screen. When two slices need the same behaviour, that behaviour graduates
> into a shared, named capability — and the feature is just its first caller.

---

## 1. Product Philosophy

- **Workflow before features.** Model the operator's real day (dispatch → return →
  inspection → invoice → payment), not a checklist of nouns.
- **Operations before reporting.** The counter must work before the dashboard does.
- **Prevent human error.** Progressive disclosure, blocked-action reasons, and
  advisory-not-blocking warnings beat hard rejections.
- **Configuration over hardcoding.** Every rule that varies per rental house lives
  in `workspace.settings.*`, never in code.
- **Inventory is the heart.** Availability, dispatch, and return are the spine
  everything else hangs from.
- **Modular monolith until scaling proves otherwise.** No premature microservices.

---

## 2. Business Architecture

- **Business Objects:** Workspace, Order, Product, Asset, Person, Dispatch, Return,
  Inspection, Invoice, Payment, Deposit, Downtime, Location.
- **Lifecycles:** each object has an explicit, advisory state machine (order:
  draft→quoted→confirmed→dispatched→returned→closed; invoice: draft→sent→paid;
  payment: pending→completed→refunded). Non-canonical jumps are allowed with intent
  (`force`), never silently.
- **Relationships:** an Order is the aggregate root; capacity claims live on
  `order_items`, physical units on `order_assets`, money on `payments`, documents on
  `invoices`. Holders/state are **derived from links**, not duplicated.
- **Events:** every mutation writes two rows — an `order_events` timeline the
  operator sees, and an `audit_events` security log. Events are the substrate the
  Timeline, Notification, and (future) Reporting engines read.

---

## 3. Platform Capabilities — the Engines

RentalOS is a set of **engines**; each slice extends an engine rather than inventing
a mechanism. An engine is real when ≥2 features share its canonical routine.

| Engine | What it owns | Status |
|---|---|---|
| **Timeline** | `order_events` vocabulary, per-order history | mature |
| **Workflow** | canonical state machines + the `commit*ToPhysicalState` routines | mature |
| **Notification** | one adapter pattern (WhatsApp/email/SMS) for every customer/internal message | mature |
| **Permission** | `PERMISSIONS` registry + `can()` on the membership row, zero extra queries | mature |
| **Document** | snapshot-immutable generation → Vercel Blob (`invoice_pdf.ts`) | emerging |
| **Money** | `payments` + `recompute()` + `applyDepositStatus()` + auto-reconciliation | **nascent (Slice 7)** |
| **Search** | workspace-scoped lookup + tag/custom-field filters | partial |
| **AI / Reporting** | analytics-on-demand; recommendations; future operational intelligence | early |

---

## 4. UX Principles

- **Progressive Disclosure** — show the next step, reveal detail on demand (the
  payment modal reveals method-specific fields only after a method is chosen).
- **Consistency** — one shell, one palette, one set of components; new pages copy
  the shell verbatim.
- **Calm Interface** — advisory warnings over hard blocks; the operator stays in
  flow.
- **Action Before Analytics** — the Command Center answers "what needs attention
  now?"; analytics answers "how are we doing?" — never conflate them.
- **Lifecycle-First Design** — the primary CTA always reflects the object's current
  lifecycle state (Prepare Dispatch → Prepare Return → Generate Invoice → Record
  Payment).

---

## 5. Engineering Principles

- **Single Source of Truth** — one canonical routine per concept; cached shortcuts
  (e.g. `orders.paid_paise`) are always recomputed from ground truth
  (`SUM(payments)`), never hand-edited.
- **Event-Driven** — mutations emit events; downstream reactions (notifications,
  reconciliation) read them.
- **Metadata-Driven** — behaviour that varies per workspace is data in `settings`,
  not branches in code.
- **API-First** — every capability is an endpoint before it is a button; the UI is a
  client.
- **Composable** — shared helpers (`commitDispatchToPhysicalState`,
  `commitReturnToPhysicalState`, `commitOrderToClosedState`, `generateInvoice`,
  `recompute`) are imported, never re-implemented.
- **Evolvable** — additive migrations, reconcile-don't-rebuild, snapshot immutability
  so history never rewrites.

---

## 6. Intelligence Layer

- **AI-Native** — the data model is built so intelligence can read it (structured
  events, typed snapshots) without a re-platform.
- **Operational Intelligence** — surface the next best action (late orders,
  awaiting-inspection, unpaid invoices) where the work happens.
- **Recommendations** — "customers also rented", ROI/divest hints — advisory, never
  automatic on money.
- **Continuous Learning** — trust scores, utilization, and reconciliation signals
  accrue as data for future models.

---

## 7. Constitution Application — the six rules

1. **Name the engine.** Every slice states which engine(s) it extends.
2. **Reuse before rebuild.** Search for an existing canonical routine first; extract
   a shared one the moment a second caller appears (the §10 threshold).
3. **Reconcile to shipped reality.** When a spec names schema/behaviour that doesn't
   exist, reconcile to what ships and document it — never silently rebuild.
4. **Config over code.** New per-house rules go to `settings.*` with a default.
5. **Two-row audit.** Every mutation writes `order_events` + `audit_events`.
6. **Additive & immutable.** Migrations are additive; snapshots and audit logs are
   append-only.

*(§10 — the extraction threshold: extract a shared helper when, and only when, a
second concrete caller emerges. Not before, not after.)*

---

## Appendix A — Engine evidence from shipped code

The engines above are not aspirational; they are visible in the codebase:

- **Workflow Engine** — the physical-commit family:
  `commitDispatchToPhysicalState` (Slice 4, `src/lib/dispatch_commit.ts`),
  `commitReturnToPhysicalState` (Slice 5, `src/lib/return_commit.ts`), and
  `commitOrderToClosedState` (Slice 6, `src/lib/order_close.ts`). Each is one
  canonical routine with multiple callers (e.g. the legacy batch dispatch/return
  endpoints and the new structured flows share the same commit).
- **Document Engine** — `src/lib/invoice_pdf.ts` renders a snapshot-immutable,
  byte-deterministic PDF and stores it to Vercel Blob (Slice 6). The same
  snapshot→Blob pattern is ready for dispatch slips and signed contracts.
- **Notification Engine** — dispatch confirmations (Slice 4), return receipts
  (Slice 5), and invoice deliveries (Slice 6) all go through the one adapter pattern
  in `src/lib/notify.ts` (`emitCustomerNotification` / `sendWhatsAppTemplate`) over
  the `workspace_integrations` adapters — no per-slice sender.
- **Money Engine (nascent, Slice 7)** — `src/routes/payments.ts` +
  `applyDepositStatus()` + `recompute()` are the money primitives; Slice 7 graduates
  them into `commitPaymentAndReconcile` + `invoice_reconcile`, so payment recording
  and refunds share one canonical commit-and-reconcile routine that also closes the
  revenue chain (payment → zero balance → invoice paid).
