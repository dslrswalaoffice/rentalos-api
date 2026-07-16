# Cron jobs — operational runbook

RentalOS runs two scheduled jobs as **GitHub Actions workflows** that ping
secret-authenticated endpoints on the deployed API. There is no persistent cron
server — GitHub's scheduler is the trigger, the Vercel function does the work.

| Workflow | File | Schedule | Endpoint |
|---|---|---|---|
| Standby expiry + reminders | `.github/workflows/standby-tick.yml` | every 15 min | `POST /api/cron/standby-tick` |
| Quote expiry monitor | `.github/workflows/quote-tick.yml` | daily 04:00 UTC | `POST /api/cron/quote-tick` |

Both are **idempotent and self-throttling** (per-row `*_sent_at` / `expiry_notified_at`
flags + status guards), so re-running — manually or on a missed schedule — is safe.

## The one required secret: `REMINDER_TRIGGER_SECRET`

Auth is a shared secret sent in the `X-Reminder-Secret` header and compared to
`process.env.REMINDER_TRIGGER_SECRET` on the server. It must be set in **BOTH**
places, to the **SAME value**:

1. **GitHub → repo Settings → Secrets and variables → Actions → New repository
   secret** — name `REMINDER_TRIGGER_SECRET`. *(The workflows read this to build
   the header.)*
2. **Vercel → project Settings → Environment Variables** — name
   `REMINDER_TRIGGER_SECRET`, same value, Production (and Preview if you test
   there). *(The endpoint compares against this.)*

Any 32+ char random hex string works; generate with `openssl rand -hex 32`. This
is the **same** secret used by the invoice-reminders cron (Sub-slice 6f) — if
that one already works in Vercel, reuse its value for the GitHub secret.

> If you change the value, change it in **both** places or the jobs 401.

## Diagnosing failures (what the responses mean)

The workflow prints the HTTP code + response body. After PR #83:

| Symptom | Meaning | Fix |
|---|---|---|
| Job fails at **"Verify REMINDER_TRIGGER_SECRET is configured"** | the **GitHub Actions secret** is missing/empty | add it (step 1 above) |
| `401 {"error":"unauthorized"}` | the GitHub secret exists but **differs** from Vercel's env var | make them equal |
| `503 {"error":"cron_secret_not_configured"}` | the **Vercel env var** is missing | add it (step 2 above), then redeploy |
| `200 {"ok":true, ...}` | success | — |

### History (why this runbook exists)
Sub-slice 2.2 cron ran 11× (standby) + 1× (quote), **all failed with `HTTP 401
{"error":"unauthorized"}`**. The Actions log showed the header rendered as
`X-Reminder-Secret: ` (empty) — GitHub masks a real secret as `***`, so an empty
value meant the **GitHub Actions secret was never configured**. The Vercel env
var was fine (the invoice-reminders cron used it). Root cause: missing GitHub
secret. PR #83 added the preflight guard + the distinct 401/503 responses so this
is obvious next time; the actual fix is adding the secret (an operator action).

## Verifying manually

Either workflow can be run on demand:

- **GitHub UI:** Actions → pick the workflow → **Run workflow** (uses `workflow_dispatch`).
- Expect a green run whose log ends with `HTTP 200` and `{"ok":true,...}`.

You can also hit the endpoint directly once the secret is set:

```bash
curl -i -X POST https://rentalos-api.vercel.app/api/cron/standby-tick \
  -H "X-Reminder-Secret: <the-secret>"
# → 200 {"ok":true,"expired":N,"customer_reminders":N,"staff_reminders":N}
```

## Manual fallback (until cron is green)

Auto-expiry is a convenience, not a hard dependency: an operator can release an
expired standby with the **Release** action on the Order 360 standby banner. So a
failing cron degrades gracefully — nothing is lost, it just needs a click.
