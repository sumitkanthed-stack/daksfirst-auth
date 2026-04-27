# Environment Variables — Staging vs Prod

Single reference for which env vars differ between **prod** (`daksfirst-auth` on Render → `apply.daksfirst.com`) and **staging** (`daksfirst-auth-staging` on Render → `apply-staging.daksfirst.com`).

Goal: same git branch deploys to both environments — env vars carry the difference.

Snapshot source: `C:\Users\sumit\auth-env-snapshot\` (kept outside OneDrive, outside git, outside any sync). Do not relocate. Do not commit secret values to this file or anywhere in git.

---

## 1. Vars that MUST differ between envs

These are the only knobs that change behaviour between staging and prod. Anything else should be identical (or absent) on both.

| Key | Prod value | Staging value | Notes |
|---|---|---|---|
| `NODE_ENV` | _(unset; falls through to `development` default)_ | `staging` | Prod should arguably be `production` — currently relies on default. Low-risk gap. |
| `DATABASE_URL` | `postgresql://daksfirst_database_user@dpg-d7aajuqdbo4c73ce7kkg-a.oregon-postgres.render.com/daksfirst_database` | `postgresql://daksfirst_auth_staging_db_user@dpg-d7nkns3eo5us73fcafs0-a/daksfirst_auth_staging_db` | Cloned schema, separate data. Staging DB has run-numbering trap — risk_view ids continue from the snapshot. |
| `AUTH_PUBLIC_BASE_URL` | _(unset; code falls back to hardcoded `https://daksfirst-auth.onrender.com` in `config/index.js`)_ | `https://daksfirst-auth-staging.onrender.com` | Read by `routes/risk.js:251` (post-fix) and `services/output-engine-dispatcher.js:59`. The fallback is the prod URL, which is why prod has worked without setting this var. |
| `JWT_SECRET` | _prod 64-char secret_ | _staging 64-char secret_ | MUST be different so a stolen prod token can't auth into staging and vice versa. Must be ≥32 chars (fail-fast in `config/index.js`). |
| `WEBHOOK_SECRET` | _prod 64-char secret_ | _staging 64-char secret_ | HMAC shared secret for n8n ↔ auth pipe. MUST differ — staging callbacks signed with prod secret would be accepted by prod auth. ≥32 chars. |
| `ALPHA_WEBHOOK_SECRET` | _shared secret A_ | _shared secret B (currently same as prod — **fix**)_ | Same isolation argument as WEBHOOK_SECRET. Audit gap: snapshot shows identical value. |
| `N8N_RISK_WEBHOOK_URL` | `https://sumitkanthed.app.n8n.cloud/webhook/risk-analysis-standalone` | `https://sumitkanthed.app.n8n.cloud/webhook/45335fc4-8430-42eb-9b04-c556db91a094` (UUID for `[STG] Risk Analysis Standalone`) | Distinct n8n workflow per env. |
| `N8N_OUTPUT_ENGINE_WEBHOOK_URL` | `…/webhook/admin-run-v2` | `…/webhook/d08a54d7-58b2-48b5-ae58-00b8984c5de0` | Distinct workflow. |
| `N8N_PARSE_WEBHOOK_URL` | `…/webhook/smart-parse` | `…/webhook/d78b595d-52f5-4bb4-b7a0-c291f346b6f0` | Distinct workflow. |
| `N8N_DATA_PARSE_URL` | `…/webhook/data-parse` | `…/webhook/data-parse` _(same)_ | Currently shared — staging clone of `data-parse` not yet built. Ship before staging UAT touches Smart Parse Data Parsing. |
| `N8N_DATA_CLASSIFY_URL` | `…/webhook/smart-parse` | `…/webhook/smart-parse` _(same)_ | Same — staging clone pending. |
| `N8N_WEBHOOK_URL` | `…/webhook/4c811581-2d51-4432-aef1-2c04d53fe71c` | `…/webhook/ba694728-a8f9-4885-af19-483e93afb10f` | Distinct workflow (legacy "deal intake"). |

---

## 2. Vars that SHOULD differ (currently don't — open work)

| Key | Prod | Staging (current) | Should be | Why |
|---|---|---|---|---|
| `FRONTEND_URL` | `https://apply.daksfirst.com` | `https://apply.daksfirst.com` | `https://apply-staging.daksfirst.com` on staging | **Confirmed orphan** — zero references across `routes/`, `services/`, `config/`, `js/`, `admin/`, frontend HTML, `vercel.json`, `db/`. Frontend uses hostname-aware switching in `js/config.js` instead. Cosmetic fix only — but harmless to set correctly so future code that adopts it Just Works. |
| `DOCUSIGN_WEBHOOK_URL` | `https://daksfirst-auth.onrender.com/api/docusign/webhook` | `https://daksfirst-auth.onrender.com/api/docusign/webhook` ⚠️ **WRONG** | `https://daksfirst-auth-staging.onrender.com/api/docusign/webhook` on staging | **Load-bearing — fix urgently.** Read at `routes/deals.js:1785` → passed as `callbackUrl` to `services/docusign.js:148` → **baked into DocuSign envelope's `eventNotification.url` at envelope creation.** If a borrower signs a staging termsheet today, DocuSign POSTs the signed-event to prod auth server, which then either mis-marks a prod deal as signed, uploads the staging PDF to prod OneDrive, or 404s and silently never completes the staging flow. Already-sent envelopes have the URL baked in — can't be re-pointed retroactively; void + re-send if signing is pending. |

### Hardcoded prod URLs in code (real bugs, not env-var problems)

These ignore env vars entirely and need code changes:

- `services/email.js:61, 139, 258` — hardcoded `https://apply.daksfirst.com` in email bodies. Test emails from staging link to prod portal.
- `config/index.js:125` — `VERIFICATION_URL_BASE: 'https://apply.daksfirst.com/verify'` hardcoded.

Fix pattern (when prioritised):
```js
PORTAL_URL: process.env.PORTAL_URL || 'https://apply.daksfirst.com',
VERIFICATION_URL_BASE: process.env.VERIFICATION_URL_BASE || 'https://apply.daksfirst.com/verify',
```
Then set on staging Render: `PORTAL_URL=https://apply-staging.daksfirst.com`.

---

## 3. Vars that are IDENTICAL on both envs (and should stay that way)

Same external service / same credentials — no env split needed:

- `ANTHROPIC_API_KEY` (single Anthropic enterprise account)
- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` (single Azure tenant; OneDrive/Graph)
- `COMPANIES_HOUSE_API_KEY` (single CH account, free tier)
- `EPC_API_EMAIL`, `EPC_API_KEY` (single EPC Register account)
- `CHIMNIE_API_KEY`, `CHIMNIE_MONTHLY_CAP_CREDITS=5000`, `CHIMNIE_TIMEOUT_MS=15000` (single Chimnie account; staging spend hits same monthly cap as prod — watch this)
- `DOCUSIGN_*` (single DocuSign demo/sandbox account; integration key, account id, user id, private key, base URL `demo.docusign.net`, auth server `account-d.docusign.com`)
- `ALPHA_API_KEY`, `ALPHA_BASE_URL=https://daksfirst-alpha.onrender.com` (single Alpha service; both envs hit the same risk modeling backend)
- `SMTP_USER=sk@daksfirst.com`, `SMTP_PASS` (single mail sender)

**Note on Chimnie**: staging draws from the same monthly credit pool as prod. Heavy staging UAT will silently eat prod's budget. Long-term fix = separate Chimnie account or `CHIMNIE_MONTHLY_CAP_CREDITS` split.

**Note on Alpha**: staging auth → prod alpha is acceptable today (alpha is read-only modeling, no writes). Revisit if alpha gets persistence.

---

## 4. The promotion ritual

Standard cycle for code-only changes (no env-var or n8n changes):

1. Edit feature code in `C:\Users\sumit\daksfirst-auth-repo-staging\` (worktree pinned to `staging` branch)
2. `git add` / `git commit` / `git push origin staging`
3. Render staging auto-redeploys (~3 min)
4. Smoke test on `apply-staging.daksfirst.com/deal/32`
5. From `C:\Users\sumit\daksfirst-auth-repo\` (worktree on `main`): `git pull origin staging && git push origin main`
6. Render prod auto-redeploys, verify on `apply.daksfirst.com/deal/32`

Three things that **don't** ride the git merge — handle separately:

- **Env vars**: new env vars on Render staging must be added on Render prod separately (this doc helps you remember what differs)
- **DB migrations**: schema changes must be applied to prod DB after merge
- **n8n canvases**: `[STG]` canvas edits must be replicated to prod canvas (manual diff in n8n UI)

---

## 5. Adding a new env var — checklist

Whenever code starts reading `config.NEW_VAR`:

1. [ ] Add `NEW_VAR: process.env.NEW_VAR || '<sane fallback>',` to `config/index.js`
2. [ ] Add row to **section 1** of this doc (or section 3 if same on both envs)
3. [ ] Set on Render staging dashboard (auto-redeploy)
4. [ ] Set on Render prod dashboard (auto-redeploy)
5. [ ] Update `C:\Users\sumit\auth-env-snapshot\daksfirst-auth.env` and `daksfirst-auth-staging.env` so future-you can grep
6. [ ] If secret: confirm staging/prod values **differ**; never reuse a prod secret on staging

If you skip step 1 you get the `PUBLIC_AUTH_URL` ghost — env var set, no code reads it, Render env var changes do nothing. First check is always: `grep "VAR_NAME:" config/index.js`.

---

## 6. What lives WHERE (don't get this wrong)

- **Real env values**: Render dashboards (prod / staging services) — single source of truth
- **Backup snapshot**: `C:\Users\sumit\auth-env-snapshot\` — local-only, outside OneDrive and git. Never commit, never sync.
- **This doc**: ships with the code, lists keys + non-secret values + behaviour. No secrets.
- **`.env` in repo**: should NOT exist. Local dev uses `.env.local` (gitignored). `dotenv` reads `.env` if present but production reads from Render-injected env directly.
