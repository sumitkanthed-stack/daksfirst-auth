# HM Land Registry (HMLR) Business Gateway Integration

**Status:** Track B (code) SHIPPED 2026-04-27 in mock mode. Track A (vendor onboarding) in flight.
**Owner:** Sumit (vendor) + Claude (code)
**Cost:** £7 per Official Copy (digital, post Dec 2024) — credit account billed monthly.

---

## 1. What this gives us

A first-party pull of the **Official Copy of the Register (OC1)** for any UK
title — the same document a conveyancer pulls. We get:

- Title number, class of title, tenure (Freehold / Leasehold)
- Proprietors (current owners — name, company number, registered office)
- Charges (existing mortgages, in rank order, with chargee + deed reference)
- Restrictions (Form A, charging order, etc.)
- A signed PDF URL for the register itself

**Why it matters for Daksfirst:** validates borrower ownership, surfaces
existing charges (rank 1 = first charge holder we'd be paying off, or
sitting behind), and exposes restrictions that could block the deal.

---

## 2. Architecture (Sumit-signed-off 2026-04-27)

| Decision | Choice |
|---|---|
| Storage | Latest pull only, columns on `deal_properties` (no separate history table). Mirrors Chimnie. |
| Visibility | Admin-only button + admin-only display panel. Not surfaced to brokers/borrowers. |
| Mode flag | `HMLR_MODE = mock\|test\|live`. Default `mock`. Live mode is the only one that charges. |
| Cost cap | `HMLR_MAX_PENCE_PER_PULL = 1000` (£10) — defensive guard against pricing surprise. Standard OC1 is 700p. |
| Auth | mTLS client cert/key + HTTP Basic (username/password) — both required for test and live. |

---

## 3. Files

| File | Purpose |
|---|---|
| `db/migrations.js` | Adds 13 `hmlr_*` columns + index on `deal_properties` |
| `config/index.js` | 9 env keys: mode, base URLs, creds, cert, passphrase, timeout, cost cap |
| `services/hmlr.js` | REST client. Mock fixtures, fail-soft `{success, error, data, status, raw, mode, cost_pence}` shape, AbortSignal timeout, redacted logs. |
| `routes/hmlr.js` | Admin-only endpoints (mounted at `/api/admin/hmlr/*`) |
| `server.js` | Mounts route + reports HMLR status in `/api/health` |

---

## 4. Endpoints

All endpoints require a JWT with `role = 'admin'` (NOT internal — strict admin only).

```
GET  /api/admin/hmlr/status                    — Mode + creds check, no network
POST /api/admin/hmlr/search                    — Body: { postcode, houseNumber? } → title list
POST /api/admin/hmlr/pull/:propertyId          — Body: { titleNumber, address? } → pulls OC1, persists, returns
GET  /api/admin/hmlr/property/:propertyId      — Reads stored HMLR data for one property
```

Pull always persists — success OR failure. Failure stamps `hmlr_pull_error`
without overwriting the previous successful pull's content cols.

---

## 5. DB columns (deal_properties)

```sql
hmlr_title_number       VARCHAR(20)    -- e.g. "NGL123456"
hmlr_register_pdf_url   TEXT           -- signed URL to register PDF
hmlr_register_raw_jsonb JSONB          -- entire API response
hmlr_proprietors_jsonb  JSONB          -- array of proprietors
hmlr_charges_jsonb      JSONB          -- array of charges (rank-ordered)
hmlr_restrictions_jsonb JSONB          -- array of restrictions
hmlr_tenure             VARCHAR(20)    -- "Freehold" | "Leasehold"
hmlr_class_of_title     VARCHAR(40)    -- "Absolute" | "Possessory" | "Qualified" | "Good Leasehold"
hmlr_pulled_at          TIMESTAMPTZ    -- last pull attempt (success or fail)
hmlr_pulled_cost_pence  INT            -- 0 for mock/test, ~700 for live
hmlr_pull_mode          VARCHAR(10)    -- mock | test | live
hmlr_pull_error         TEXT           -- NULL on success, populated on fail
hmlr_pulled_by          INT            -- FK to users.id (audit)
```

Index: `idx_deal_props_hmlr_title ON deal_properties(hmlr_title_number)`.

---

## 6. Env vars (Render: prod + staging)

```bash
# Mode — leave as 'mock' until cert + creds are live
HMLR_MODE=mock

# URLs (defaults are fine for test sandbox + live)
HMLR_TEST_BASE_URL=https://bgtest.landregistry.gov.uk/bg2test/api
HMLR_LIVE_BASE_URL=https://businessgateway.landregistry.gov.uk/api

# Basic Auth
HMLR_USERNAME=
HMLR_PASSWORD=

# mTLS — paste the PEM bodies; literal '\n' will be converted to newlines (DocuSign pattern)
HMLR_CLIENT_CERT="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
HMLR_CLIENT_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
HMLR_CLIENT_KEY_PASSPHRASE=

# Timeouts and caps
HMLR_TIMEOUT_MS=30000
HMLR_MAX_PENCE_PER_PULL=1000
```

---

## 7. Vendor onboarding (Track A — Sumit)

HMLR Business Gateway is **not self-serve** — formal application required.
Realistic timeline: **3–5 weeks** before first live OC1 in production.

| Step | Action | Owner |
|---|---|---|
| A1 | Email `channelpartners@landregistry.gov.uk` for development license | Sumit |
| A2 | Apply for HMLR Business e-services on gov.uk | Sumit |
| A3 | Open HMLR credit account (for billing) | Sumit |
| A4 | Apply for HMLR test SSL cert pair | Sumit |

Signed dev license unlocks the test sandbox. Once tested, request a live
cert pair and flip `HMLR_MODE=live`.

---

## 8. Promotion path

| Stage | `HMLR_MODE` | What happens |
|---|---|---|
| Day 0 (now) | `mock` | Service returns canned fixtures. Cost = 0. No network. Frontend can be built end-to-end. |
| Dev license arrives | `test` on staging Render env only | Real network calls to bgtest sandbox. mTLS exercised. Cost = 0. |
| Live cert + credit account | `live` on prod Render env | Real OC1 pulls. Cost = £7/pull. Watch first invoice. |

Per `feedback_split_branches_liberally.md` and the prod ↔ staging sync
rhythm, never flip `live` on staging — staging is the canary for code, not
for vendor billing.

---

## 9. Future extensions (deferred)

- **OC2** — Official Copy of Title Plan (the boundary plan) — same auth, separate product code.
- **Search of the Index Map (SIM)** — finds title number for unregistered land.
- **Bankruptcy search (K15)** — companion to KYC for individual borrowers.
- **Webhook notification** — HMLR pushes us when registered titles change after we've pulled. Useful for portfolio monitoring; not in scope for MVP.

---

## 10. Open questions to revisit when Track A completes

1. Per-pull cost cap (`HMLR_MAX_PENCE_PER_PULL`) — confirm 1000p is right after we see live HMLR pricing rules (some products are in shillings of an hour, not flat £).
2. Should we surface charges + restrictions on the broker-facing matrix panel (currently admin-only per Sumit's call)? Likely yes once we trust the data — fits the "matrix is canonical" principle.
3. Auto-trigger pull on property creation, vs manual admin button? Currently manual. Auto would burn ~£7 per submitted property whether or not we proceed — manual is safer until volume normalises.
