# Refreshing staging from prod

When to do this: staging has drifted from prod (different commits, stale data, abandoned experiments) and you want it to be a clean clone of prod again — typically before testing a risky change or after a big prod milestone.

**Three components**, run in this order. ~10 minutes end-to-end.

## Step 1 — Code (git)

Reset the `staging` branch to match `main` exactly.

```bash
cd /c/Users/sumit/daksfirst-auth-repo-staging
git fetch origin
git checkout staging
git reset --hard origin/main
git push origin staging --force-with-lease
```

Render staging auto-redeploys → ~3 min.

⚠ Any commits on `staging` that aren't on `main` are erased. Intentional — that's the "refresh" goal. If you want to preserve a staging-only experiment, branch it off first: `git branch staging-experiment-2026-04-27` before resetting.

## Step 2 — Database

Dump prod, restore into staging.

```bash
ENV_FILE_PROD="/c/Users/sumit/auth-env-snapshot/daksfirst-auth.env"
ENV_FILE_STG="/c/Users/sumit/auth-env-snapshot/daksfirst-auth-staging.env"

PROD_DB=$(grep '^DATABASE_URL=' "$ENV_FILE_PROD" | cut -d= -f2-)
STG_DB=$(grep '^DATABASE_URL=' "$ENV_FILE_STG" | cut -d= -f2-)

# 1. Dump prod
TS=$(date +%Y-%m-%d-%H%M)
DUMP="/c/Users/sumit/daksfirst-backups/prod-db-${TS}-staging-refresh.sql"
mkdir -p /c/Users/sumit/daksfirst-backups
pg_dump "$PROD_DB" --no-owner --no-acl > "$DUMP"

# 2. Wipe staging schema + restore from dump
psql "$STG_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$STG_DB" < "$DUMP"
```

⚠ DESTRUCTIVE on staging. Any test data on staging is gone — that's the point. If you wanted to keep something, you should have backed it up first.

**Run-numbering trap**: `risk_view.id` is a SERIAL. After restore, staging's next row will use the next id from the prod sequence, NOT 1. Fine for testing, just be aware that staging risk_view ids and prod risk_view ids will overlap going forward.

## Step 3 — n8n canvases

The canvases live in n8n Cloud, NOT in your DB or git. Two options:

### Option A — keep [STG] canvases as-is (recommended)

If your [STG] canvases haven't drifted from their prod counterparts in any meaningful way, do nothing. The webhook URLs in the staging Render env vars already point to the [STG] canvas UUIDs, and those canvases will keep working.

### Option B — re-clone prod canvases as [STG]

If you've made significant edits to a prod canvas and want staging to match:

1. Open the prod canvas in n8n Cloud → ⋯ → Download (saves JSON)
2. Open the [STG] canvas → ⋯ → Delete (or rename `[STG-OLD]` to keep for diff)
3. Import the JSON → rename to `[STG] <name>`
4. **Manually rewrite per-canvas:**
   - Webhook node: change the path to a new UUID (so prod and staging webhooks don't collide)
   - Callback Auth node: change Allowed Domain to `daksfirst-auth-staging.onrender.com`
   - Callback URL inside any HTTP Request node: change to staging auth URL
   - Re-attach credentials (Anthropic key, HMAC secret = staging `WEBHOOK_SECRET`, Postgres = staging DB)
5. Activate the canvas
6. **Update Render staging env var** for that canvas's webhook URL (the new UUID)

This is the manual tax for refreshing canvases. Plan for ~10 min per canvas if you're doing all five.

## Step 4 — env vars (verify, don't change)

After steps 1-3, the staging Render env vars should still be correct (DB URL, AUTH_PUBLIC_BASE_URL, n8n webhook UUIDs). Cross-check against `docs/ENV_VARS.md` if anything seems off. Do **not** change them to match prod — staging env vars stay distinct by design.

## Step 5 — smoke test

Open `https://apply-staging.daksfirst.com/deal/32` and confirm:

- Page loads (proves staging code is alive)
- Risk View tab shows recent runs (proves DB restore worked + risk_view rows came across)
- "Run Risk Analysis" → green pipeline (proves n8n canvases + HMAC pipe still wired)
- (Optional) Re-run output engine for a recent deal to confirm OE canvas works

If any of these fail, check `docs/ENV_VARS.md` for the var that's likely missing or pointed at the wrong env.

---

## Summary table

| Step | Time | Destructive on staging? | Manual? |
|---|---|---|---|
| 1. Git reset | ~3 min (incl. Render redeploy) | Yes (drops staging-only commits) | No |
| 2. DB dump + restore | ~5 min | Yes (drops staging data) | No |
| 3. n8n canvas re-clone | ~10 min per canvas | Yes if Option B | Yes |
| 4. Env var verify | ~1 min | No | Cross-check vs ENV_VARS.md |
| 5. Smoke test | ~5 min | No | Yes — open browser |
