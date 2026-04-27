#!/usr/bin/env bash
# Backup prod before risky changes. Run from Git Bash.
# Usage:  bash scripts/backup-prod.sh "reason-for-backup"
#         e.g.  bash scripts/backup-prod.sh "before-v5-canvas-rewrite"
#
# Three things backed up:
#   1. Git tag on main HEAD (pushed to origin)
#   2. Postgres dump of prod DB → C:\Users\sumit\daksfirst-backups\
#   3. Reminder to manually export n8n canvases (n8n Cloud has no CLI)
#
# Prereqs:
#   - pg_dump installed and on PATH (comes with Postgres install or `winget install postgresql`)
#   - Git Bash (you already have this)
#   - C:\Users\sumit\auth-env-snapshot\daksfirst-auth.env exists with DATABASE_URL

set -euo pipefail

REASON="${1:-pre-change}"
TS=$(date +%Y-%m-%d-%H%M)
TAG="prod-stable-${TS}-${REASON}"
BACKUP_DIR="/c/Users/sumit/daksfirst-backups"
ENV_FILE="/c/Users/sumit/auth-env-snapshot/daksfirst-auth.env"
REPO_DIR="/c/Users/sumit/daksfirst-auth-repo"

mkdir -p "$BACKUP_DIR"

# 1. Git tag + push to origin
cd "$REPO_DIR"
git fetch origin
git checkout main
git pull origin main
git tag -a "$TAG" -m "Pre-change backup: $REASON"
git push origin "$TAG"
echo "✓ Git tag pushed: $TAG"

# 2. Postgres dump
DATABASE_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
DUMP_FILE="$BACKUP_DIR/prod-db-${TS}-${REASON}.sql"
pg_dump "$DATABASE_URL" --no-owner --no-acl > "$DUMP_FILE"
echo "✓ DB dumped: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# 3. n8n canvas reminder (no Cloud CLI exists)
echo ""
echo "⚠ MANUAL STEP if you're touching n8n canvases:"
echo "  → https://sumitkanthed.app.n8n.cloud/"
echo "  → for each affected workflow: ⋯ menu → Download"
echo "  → save JSON files to: $BACKUP_DIR/n8n-${TS}-${REASON}/"
echo ""
echo "Restore recipe stored at: docs/RESTORE_FROM_BACKUP.md"
