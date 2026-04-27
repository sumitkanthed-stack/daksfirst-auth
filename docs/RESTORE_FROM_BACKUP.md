# Restoring prod from a backup

Three components, three restore paths. Use whichever ones got corrupted.

## 1. Code — restore from git tag

```bash
cd /c/Users/sumit/daksfirst-auth-repo
git checkout main
git reset --hard prod-stable-2026-04-27-1530-before-v5-canvas-rewrite   # use the tag your script printed
git push origin main --force-with-lease
```

Force-push on `main` is normally forbidden — but for a true rollback after a known-bad change, it's the right tool. `--force-with-lease` rejects the push if anyone else committed in the meantime (sanity check, since you shouldn't be force-pushing past Sumit's other commits).

Render auto-redeploys main → ~3 min.

## 2. Database — restore from `pg_dump` file

```bash
ENV_FILE="/c/Users/sumit/auth-env-snapshot/daksfirst-auth.env"
DATABASE_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)

# Wipe + restore (DESTRUCTIVE — confirm you want this)
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" < /c/Users/sumit/daksfirst-backups/prod-db-2026-04-27-1530-before-v5-canvas-rewrite.sql
```

⚠ Anything that landed in prod between the dump and now is **gone**. If unsure, dump the current (broken) state first to a different filename so you have it to diff against.

## 3. n8n canvases — re-import JSON exports

Manual in n8n UI. For each affected workflow:

1. Open the broken canvas
2. ⋯ menu → Delete (or rename it `[BROKEN-2026-04-27]` to keep for forensics)
3. Top-right → Add workflow → Import from File → upload the JSON from `daksfirst-backups/n8n-...-...`
4. Re-attach credentials (Anthropic, HMAC, Postgres) — credentials don't ship in the JSON export
5. Re-activate the workflow

Webhook URLs and node IDs survive the round-trip. Credentials don't.

## When NOT to restore

If the bug is "wrong rate displayed on a memo" or "missing column on a tab" — don't restore. Just `git revert <commit>` the offending commit. Restore is for "the DB schema is corrupted" or "every deal page returns 500" level events.
