# Daksfirst Auth Portal — Deployment Guide v2.0

## What Changed
- Frontend: `submitRegistration()` now calls real API (was demo stub)
- Frontend: Added login screen, deal submission form, deal success screen
- Server: Added `/api/deals/submit` endpoint with database storage
- Server: Added n8n webhook trigger on every deal submission (with 4x retry)
- Server: Added `/api/deals` endpoint (list user's deals)
- Database: New tables — `deal_submissions`, `webhook_log`

---

## Step-by-Step Deployment

### STEP 1: Create Database Tables

Go to Render Dashboard > daksfirst-database > Shell (or use the PSQL Command from the Info page).

Paste the contents of `setup.sql` and run it. This creates:
- `users` table (if not already there)
- `deal_submissions` table
- `webhook_log` table

### STEP 2: Set Environment Variables on daksfirst-auth

Go to: https://dashboard.render.com/web/srv-d7aah6vpm1nc73c26c90/env

Add or verify these environment variables:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | (Internal Database URL from daksfirst-database — should already be set) |
| `JWT_SECRET` | (Any strong random string — should already be set) |
| `N8N_WEBHOOK_URL` | The n8n Webhook URL (see Step 4) |
| `WEBHOOK_SECRET` | `daksfirst_webhook_2026` (or any shared secret) |
| `SMTP_USER` | `sk@daksfirst.com` (for verification emails) |
| `SMTP_PASS` | (Your Outlook app password) |

### STEP 3: Push Code to GitHub

Replace the 3 files in the `sumitkanthed-stack/daksfirst-auth` repo:

1. `server.js` — the updated backend
2. `index.html` — the updated frontend (real API calls)
3. `package.json` — version bump to 2.0.0

Since Auto-Deploy is ON, Render will pick up the push and redeploy automatically.

### STEP 4: Create n8n Webhook for Deal Intake

In your n8n workflow:

1. The Webhook node already exists in the workflow (visible in screenshot)
2. Open the Webhook node — copy the Production webhook URL
3. Paste that URL as `N8N_WEBHOOK_URL` in the Render environment variables (Step 2)
4. The webhook sends this JSON payload:

```json
{
  "submissionId": "uuid",
  "source": "web_form",
  "timestamp": "2026-04-09T...",
  "submittedBy": { "userId": 1, "email": "...", "role": "broker" },
  "borrower": { "name": "...", "company": "...", "email": "...", "phone": "..." },
  "broker": { "name": "...", "company": "...", "fca_number": "..." },
  "security": { "address": "...", "postcode": "...", "asset_type": "...", "current_value": 2500000 },
  "loan": { "amount": 1750000, "ltv_requested": 70.0, "purpose": "...", "exit_strategy": "...", "term_months": 12 },
  "documents": [],
  "additional_notes": "..."
}
```

5. In the n8n workflow, the Code in JavaScript node after the Webhook can parse this payload and format it for the existing pipeline (Perplexity + Claude + document generation)

### STEP 5: Update Vercel Frontend

The `index.html` also needs to be deployed to Vercel (apply.daksfirst.com). Two options:

**Option A** — If apply.daksfirst.com is served from the same GitHub repo:
Push `index.html` to GitHub and Vercel will auto-deploy.

**Option B** — If apply.daksfirst.com is a separate Vercel project:
Go to your Vercel dashboard, find the project, and update the `index.html` there.

### STEP 6: Test End-to-End

1. Go to https://apply.daksfirst.com
2. Click "I'm a Broker" or "I'm a Borrower"
3. Fill in registration form — should see "Account Created Successfully"
4. Click "Submit a Deal" — fill in property + loan details
5. Check Render logs for `[deal] Created:` and `[webhook] Success`
6. Check n8n execution history for the incoming webhook

---

## Architecture After Deployment

```
Broker/Borrower
     |
     v
apply.daksfirst.com (Vercel)
     |
     | POST /api/auth/register
     | POST /api/deals/submit
     v
daksfirst-auth (Render Node.js)
     |
     |--- writes to ---> daksfirst-database (Render PostgreSQL)
     |
     |--- webhook POST ---> n8n Webhook node
                               |
                               v
                         Existing Pipeline:
                         Perplexity → Claude → Credit Memo + Termsheet
                               |
                               v
                         Email to sk@daksfirst.com
```
