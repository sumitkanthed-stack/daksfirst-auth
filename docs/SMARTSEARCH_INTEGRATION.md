# SmartSearch (KYC / AML / Sanctions / PEP / Monitoring) Integration

**Status:** Track B (code) SHIPPED 2026-04-27 in mock mode. Track A (vendor onboarding) in flight.
**Owner:** Sumit (vendor) + Claude (code)
**Cost:** Per-check pricing — confirmed by SmartSearch on contract sign. Indicative: Individual KYC ~£3-5, Business KYB ~£8-12, Sanctions/PEP ~£2, Monitoring ~£0.50/subject/month.

---

## 1. What this gives us

SmartSearch is the UK's most-used KYC/AML provider for SME lenders. It hits the
Dow Jones Watchlist (1,100+ sanctions/PEP sources) plus electoral roll,
mortality register, address history, and business registries. Returns are
typically <2 seconds in live mode.

**Four products, one vendor:**

| Product | What it does | When to fire |
|---|---|---|
| Individual KYC | Verifies identity (electoral, mortality, address, document checks) | On every individual borrower / guarantor |
| Business KYB | Verifies the corporate (incorporation, status, directors, UBOs) | On every corporate borrower |
| Sanctions/PEP | Screens individuals against 1,100+ lists (sanctions, PEPs, RCAs, SIPs, adverse media) | On every individual party (borrowers, directors, UBOs) |
| Ongoing monitoring | Subscribes a passed check; vendor pushes status changes via webhook | Admin-pick on passed checks (NOT auto) |

**Why it matters for Daksfirst:** anti-money-laundering compliance is mandatory
under the UK Money Laundering Regulations 2017. Without these checks we cannot
lawfully advance funds. Today this is done manually via PDFs from solicitors —
SmartSearch automates it inside the portal.

---

## 2. Architecture (Sumit-signed-off 2026-04-27)

| Decision | Choice | Why |
|---|---|---|
| Storage | Separate `kyc_checks` table, append-only | Compliance audit needs full history, not latest-only |
| Trigger (Q1) | Manual button only — admin role | High-cost calls; no auto-fire on borrower create |
| Per-subject vs batch (Q2) | Both — individual endpoints + sweep endpoint for directors | One-by-one for first deal, batch when volume normalises |
| Monitoring (Q3) | Admin-pick — never auto-enrol | Recurring fee; admin decides which subjects warrant ongoing watch |
| Mode flag | `SMARTSEARCH_MODE = mock\|test\|live`. Default `mock`. | Prod-safe with no creds; flip per-environment when ready |
| Cost cap | `SMARTSEARCH_MAX_PENCE_PER_CHECK = 500` (£5) | Defensive guard against pricing surprise on premium products |
| Auth | HTTP Basic + `X-API-Key` header | SmartSearch standard |
| Webhook | HMAC-SHA256 verified via `SMARTSEARCH_WEBHOOK_SECRET` | NOT admin-gated — vendor pushes monitoring updates |

---

## 3. Files

| File | Purpose |
|---|---|
| `db/migrations.js` | Adds `kyc_checks` table + 7 indexes |
| `config/index.js` | 10 env keys: mode, base URLs, creds, API key, webhook secret, timeout, cost cap |
| `services/smartsearch.js` | REST client. Mock fixtures, fail-soft `{success, error, data, status, raw, mode, cost_pence}` shape, AbortSignal timeout, redacted logs, `verifyWebhookSignature()` helper. |
| `routes/kyc.js` | Two routers: `adminRouter` (admin-only) and `webhookRouter` (HMAC-verified) |
| `server.js` | Adds `verify` callback to `express.json` for raw body capture; mounts both routers; reports SmartSearch status in `/api/health` |

---

## 4. Endpoints

### Admin (require JWT with `role = 'admin'`)

```
GET  /api/admin/kyc/status                          — Mode + creds check, no network
POST /api/admin/kyc/individual/:borrowerId          — Body: { firstName?, lastName?, dob?, address? } (defaults from borrower row)
POST /api/admin/kyc/business/:borrowerId            — Body: { companyNumber?, companyName? } (corporate borrower)
POST /api/admin/kyc/sanctions/:borrowerId           — Body: { firstName?, lastName?, dob? } (per individual)
POST /api/admin/kyc/sweep/:borrowerId               — Body: { includeKyb?, includeIndividual?, includeSanctions? } (corporate parent + all directors)
POST /api/admin/kyc/monitor/:checkId                — Body: { frequency? } (enrol passed check into monitoring)
GET  /api/admin/kyc/checks?dealId=X&borrowerId=Y    — History list, newest first, max 200
GET  /api/admin/kyc/check/:checkId                  — Full single check (incl raw vendor response)
```

### Public (HMAC-verified, NOT admin-gated)

```
POST /api/webhooks/smartsearch                      — Vendor pushes monitoring updates
                                                      Header: X-SmartSearch-Signature: <hex HMAC-SHA256>
                                                      Body:   { vendor_reference, parent_check_reference, status, score,
                                                                sanctions_hits, pep_hits, ..., raw }
```

Every admin endpoint always persists a `kyc_checks` row — success OR failure.
Failure rows have `result_status = 'error'` and `pull_error` populated.

---

## 5. DB schema (`kyc_checks`)

Append-only run-log. Mirrors `risk_view` pattern. Foreign keys nullable so
webhook-driven monitoring updates can land without a logged-in user.

```sql
id                      SERIAL PK
deal_id                 INT
borrower_id             INT
director_id             INT          -- when subject is a director (parent_borrower_id set)
individual_id           INT          -- generic individual (reserved)
company_id              INT          -- when subject is a corporate borrower
check_type              VARCHAR(40)  -- individual_kyc | business_kyb | sanctions_pep | ongoing_monitoring
provider                VARCHAR(40)  -- 'smartsearch' (allows future Onfido/Veriff/Equifax)
subject_first_name      VARCHAR(120)
subject_last_name       VARCHAR(120)
subject_dob             DATE
subject_address_jsonb   JSONB
subject_company_number  VARCHAR(20)
subject_company_name    VARCHAR(255)
result_status           VARCHAR(20)  -- pass | refer | fail | error
result_score            INT
result_summary_jsonb    JSONB
result_raw_jsonb        JSONB        -- full vendor response (audit)
sanctions_hits_jsonb    JSONB
pep_hits_jsonb          JSONB
rca_hits_jsonb          JSONB
sip_hits_jsonb          JSONB
adverse_media_jsonb     JSONB
mode                    VARCHAR(10)  -- mock | test | live
cost_pence              INT
requested_by            INT          -- FK users.id (NULL on webhook updates)
requested_at            TIMESTAMPTZ
parent_check_id         INT          -- FK self (monitoring update → original check)
is_monitoring_update    BOOLEAN
pull_error              TEXT
```

Indexes: `deal_id`, `borrower_id`, `company_id`, `director_id`, `check_type`,
`parent_check_id`, and composite `(deal_id, check_type, requested_at DESC)` for
"latest per type per deal" queries.

---

## 6. Env vars (Render: prod + staging)

```bash
# Mode — leave as 'mock' until creds are live
SMARTSEARCH_MODE=mock

# URLs (defaults are placeholders — confirm with vendor onboarding pack)
SMARTSEARCH_TEST_BASE_URL=https://api-test.smartsearchsecure.com/v1
SMARTSEARCH_LIVE_BASE_URL=https://api.smartsearchsecure.com/v1

# Auth
SMARTSEARCH_USERNAME=
SMARTSEARCH_PASSWORD=
SMARTSEARCH_API_KEY=

# Webhook HMAC secret (vendor provides on monitoring setup)
SMARTSEARCH_WEBHOOK_SECRET=

# Timeouts and caps
SMARTSEARCH_TIMEOUT_MS=30000
SMARTSEARCH_MAX_PENCE_PER_CHECK=500
```

---

## 7. Vendor onboarding (Track A — Sumit)

| Step | Action | Owner |
|---|---|---|
| A1 | Sign up at smartsearch.com → request sandbox account | Sumit |
| A2 | Capture sandbox creds (username, password, API key, webhook secret) | Sumit |
| A3 | Sign live contract, agree per-product pricing, capture live creds | Sumit |

Realistic timeline: **1-2 weeks** from sandbox application to live access.
SmartSearch advertises 24-hour deploy for the sandbox; live activation needs a
signed contract + AML risk questionnaire.

---

## 8. Promotion path

| Stage | `SMARTSEARCH_MODE` | What happens |
|---|---|---|
| Day 0 (now) | `mock` (default) | Service returns canned fixtures. Cost = 0. No network. Frontend can be built end-to-end. |
| Sandbox creds (A2) | `test` on staging Render only | Real network calls to bgtest sandbox. Cost = 0. |
| Live creds (A3) | `live` on prod Render only | Real per-check charges. Watch first invoice. |

Per `feedback_split_branches_liberally.md` and the prod ↔ staging sync rhythm,
**never flip `live` on staging** — staging is the canary for code, not for
vendor billing.

---

## 9. Webhook signing

SmartSearch signs each webhook request with HMAC-SHA256 over the raw body, sent
in either the `X-SmartSearch-Signature` or `X-Signature` header. Some vendors
prefix with `sha256=` — `verifyWebhookSignature()` handles both forms.

For verification to work, `server.js` captures the raw body bytes via
`express.json({ verify: (req, res, buf) => { req.rawBody = buf } })`. Without
this hook, downstream routes would only see the parsed object (which cannot
faithfully be re-stringified to match the vendor's signed bytes).

If `SMARTSEARCH_WEBHOOK_SECRET` is unset, verification fails closed — no row
is written and the vendor receives 401.

---

## 10. Future extensions (deferred)

- **Auto-trigger on borrower save** — currently manual per Sumit's Q1. Revisit when volume normalises and per-deal cost is acceptable.
- **Per-borrower monitoring toggle UI** — instead of clicking "Enrol" per check, an admin checkbox on the borrower panel that auto-enrols every passed check for that subject.
- **Document upload check** — SmartSearch supports passport/driving-licence image upload for stronger KYC. Not in MVP; would need DocuSign-style file handling.
- **Adverse media deep-dive** — if a sanctions/PEP screening returns adverse media hits, the raw URLs/snippets sit in `adverse_media_jsonb` but aren't surfaced. Add a render path on the borrower panel if false-positive rate is workable.
- **Cost dashboard** — sum `cost_pence` per month, per check_type, per deal. Useful for invoice reconciliation and pricing renegotiation.

---

## 11. Open questions to revisit when Track A completes

1. **Real endpoint paths.** `services/smartsearch.js` uses placeholder paths (`/checks/individual`, `/checks/business`, `/checks/screening`, `/monitoring/enrol`). Vendor onboarding pack will confirm — update before flipping `test`.
2. **Cost cap (500p / £5).** Confirm against actual SmartSearch pricing — raise if KYB is genuinely £8-12.
3. **Webhook signature header name.** Currently checking `X-SmartSearch-Signature` first, falling back to `X-Signature`. Confirm with vendor docs.
4. **Result status enum.** Mock returns `pass`/`refer`/`fail`/`error`. Confirm SmartSearch uses these exact values; otherwise add a normaliser in `extractFlatFields()`.
5. **Subject name parsing.** `splitName()` does first-token / rest split — fine for "JANE DOE" but lossy for "JEAN-PIERRE DE LA ROCHE". Decide whether to add a structured `first_name` + `last_name` column to `deal_borrowers`, or accept the heuristic for now.
