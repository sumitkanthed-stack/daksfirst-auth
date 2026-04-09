require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
// nodemailer removed — using Microsoft Graph API for email
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const multer     = require('multer');
const path       = require('path');

const app = express();
app.set('trust proxy', 1); // Trust Render's proxy for rate limiting
app.use(express.json({ limit: '10mb' }));

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://apply.daksfirst.com',
    'https://daksfirst-auth.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── Rate limiting ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth', authLimiter);

const dealLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 100 });
app.use('/api/deals', dealLimiter);

const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/admin', adminLimiter);

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Email (via Microsoft Graph API) ────────────────────────────────────────
// SMTP is blocked by Office 365 security defaults, so we use Graph API instead

// ── n8n Webhook URL ───────────────────────────────────────────────────────
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// ── JWT ────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'daksfirst_default_secret';

// ── Microsoft Graph / Azure AD ─────────────────────────────────────────────
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';

// ── Multer for file uploads ────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per file
    files: 10 // max 10 files per request
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO-MIGRATE: CREATE TABLES ON STARTUP
// ═══════════════════════════════════════════════════════════════════════════
async function runMigrations() {
  try {
    console.log('[migrate] Running database migrations...');

    // Users table with admin role support
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        role            VARCHAR(20)   NOT NULL CHECK (role IN ('broker', 'borrower', 'admin')),
        first_name      VARCHAR(100)  NOT NULL,
        last_name       VARCHAR(100)  NOT NULL,
        email           VARCHAR(255)  NOT NULL UNIQUE,
        phone           VARCHAR(30)   NOT NULL,
        company         VARCHAR(200),
        fca_number      VARCHAR(50),
        loan_purpose    VARCHAR(50),
        loan_amount     NUMERIC(15,2),
        source          VARCHAR(50)   DEFAULT 'portal',
        password_hash   TEXT          NOT NULL,
        verification_token TEXT,
        email_verified  BOOLEAN       DEFAULT FALSE,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_role  ON users(role);`);

    // Deal submissions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_submissions (
        id                SERIAL PRIMARY KEY,
        submission_id     UUID          DEFAULT gen_random_uuid() UNIQUE,
        user_id           INT           REFERENCES users(id),
        status            VARCHAR(30)   DEFAULT 'received' CHECK (status IN ('received','processing','completed','failed','declined')),
        borrower_name     VARCHAR(200),
        borrower_company  VARCHAR(200),
        borrower_email    VARCHAR(255),
        borrower_phone    VARCHAR(30),
        broker_name       VARCHAR(200),
        broker_company    VARCHAR(200),
        broker_fca        VARCHAR(50),
        security_address  TEXT,
        security_postcode VARCHAR(15),
        asset_type        VARCHAR(50),
        current_value     NUMERIC(15,2),
        loan_amount       NUMERIC(15,2),
        ltv_requested     NUMERIC(5,2),
        loan_purpose      VARCHAR(100),
        exit_strategy     TEXT,
        term_months       INT,
        rate_requested    NUMERIC(5,2),
        documents         JSONB         DEFAULT '[]'::jsonb,
        additional_notes  TEXT,
        admin_notes       TEXT,
        assigned_to       INT           REFERENCES users(id),
        internal_status   VARCHAR(50)   DEFAULT 'new',
        webhook_status    VARCHAR(20)   DEFAULT 'pending' CHECK (webhook_status IN ('pending','sent','failed','retrying')),
        webhook_attempts  INT           DEFAULT 0,
        webhook_last_try  TIMESTAMPTZ,
        webhook_response  TEXT,
        source            VARCHAR(50)   DEFAULT 'web_form',
        created_at        TIMESTAMPTZ   DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    // Basic indexes (columns that exist in original CREATE TABLE)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_status      ON deal_submissions(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_user        ON deal_submissions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_submission   ON deal_submissions(submission_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_webhook      ON deal_submissions(webhook_status);`);

    // Webhook log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_log (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        attempt         INT           NOT NULL,
        status_code     INT,
        response_body   TEXT,
        error_message   TEXT,
        sent_at         TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    // Deal documents table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_documents (
        id                SERIAL PRIMARY KEY,
        deal_id           INT           REFERENCES deal_submissions(id),
        filename          VARCHAR(500)  NOT NULL,
        file_type         VARCHAR(50),
        file_size         INT,
        onedrive_item_id  TEXT,
        onedrive_path     TEXT,
        onedrive_download_url TEXT,
        uploaded_at       TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_docs_deal ON deal_documents(deal_id);`);

    try {
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS parse_session_id UUID;`);
      console.log('[migrate] Added parse_session_id to deal_documents');
    } catch(e) { console.log('[migrate] deal_documents parse_session_id note:', e.message.substring(0, 60)); }

    // Analysis results table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analysis_results (
        id                SERIAL PRIMARY KEY,
        deal_id           INT           REFERENCES deal_submissions(id) UNIQUE,
        credit_memo_url   TEXT,
        termsheet_url     TEXT,
        gbb_memo_url      TEXT,
        analysis_json     JSONB,
        completed_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analysis_deal ON analysis_results(deal_id);`);

    // Client notes table (CRM)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_notes (
        id                SERIAL PRIMARY KEY,
        user_id           INT           REFERENCES users(id),
        deal_id           INT           REFERENCES deal_submissions(id),
        note              TEXT          NOT NULL,
        created_by        INT           REFERENCES users(id),
        created_at        TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_user ON client_notes(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_deal ON client_notes(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_creator ON client_notes(created_by);`);

    // Deal audit log table (tracks every action on a deal)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_audit_log (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        action          VARCHAR(100)  NOT NULL,
        from_value      TEXT,
        to_value        TEXT,
        details         JSONB,
        performed_by    INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_deal ON deal_audit_log(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON deal_audit_log(performed_by);`);

    // Fee payments table (tracks DIP fee, commitment fee, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_fee_payments (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        fee_type        VARCHAR(50)   NOT NULL,
        amount          NUMERIC(15,2) NOT NULL,
        payment_date    DATE          NOT NULL,
        payment_ref     VARCHAR(200),
        notes           TEXT,
        confirmed_by    INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fees_deal ON deal_fee_payments(deal_id);`);

    // Deal approvals table (tracks each stage of the approval chain)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_approvals (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        approval_stage  VARCHAR(50)   NOT NULL,
        decision        VARCHAR(20)   NOT NULL CHECK (decision IN ('approve', 'decline', 'more_info')),
        comments        TEXT,
        decided_by      INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_approvals_deal ON deal_approvals(deal_id);`);

    // Broker onboarding table (KYC for fee payments)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broker_onboarding (
        id              SERIAL PRIMARY KEY,
        user_id         INT           REFERENCES users(id) UNIQUE,
        status          VARCHAR(30)   DEFAULT 'pending' CHECK (status IN ('pending','submitted','under_review','approved','rejected')),
        individual_name VARCHAR(200),
        date_of_birth   DATE,
        passport_doc_id INT,
        proof_of_address_doc_id INT,
        is_company      BOOLEAN       DEFAULT FALSE,
        company_name    VARCHAR(200),
        company_number  VARCHAR(50),
        incorporation_doc_id INT,
        bank_name       VARCHAR(200),
        bank_sort_code  VARCHAR(10),
        bank_account_no VARCHAR(20),
        bank_account_name VARCHAR(200),
        notes           TEXT,
        reviewed_by     INT           REFERENCES users(id),
        reviewed_at     TIMESTAMPTZ,
        default_rm      INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_onb_user ON broker_onboarding(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_onb_status ON broker_onboarding(status);`);

    // Law firms table (for legal instruction tracking)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS law_firms (
        id              SERIAL PRIMARY KEY,
        firm_name       VARCHAR(200)  NOT NULL,
        contact_name    VARCHAR(200),
        email           VARCHAR(255),
        phone           VARCHAR(30),
        address         TEXT,
        notes           TEXT,
        is_active       BOOLEAN       DEFAULT TRUE,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_law_firms_active ON law_firms(is_active);`);

    // Deal borrowers table (supports multiple borrowers per deal)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_borrowers (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        role            VARCHAR(30)   DEFAULT 'primary' CHECK (role IN ('primary','joint','guarantor','director')),
        full_name       VARCHAR(200)  NOT NULL,
        date_of_birth   DATE,
        nationality     VARCHAR(100),
        jurisdiction    VARCHAR(100),
        email           VARCHAR(255),
        phone           VARCHAR(30),
        address         TEXT,
        borrower_type   VARCHAR(30)   DEFAULT 'individual',
        company_name    VARCHAR(200),
        company_number  VARCHAR(50),
        kyc_status      VARCHAR(30)   DEFAULT 'pending' CHECK (kyc_status IN ('pending','submitted','verified','rejected')),
        kyc_data        JSONB         DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_borrowers_deal ON deal_borrowers(deal_id);`);

    // Deal properties table (portfolio support — multiple properties per deal)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_properties (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        address         TEXT          NOT NULL,
        postcode        VARCHAR(15),
        property_type   VARCHAR(50),
        tenure          VARCHAR(30),
        occupancy       VARCHAR(30),
        current_use     VARCHAR(50),
        market_value    NUMERIC(15,2),
        purchase_price  NUMERIC(15,2),
        gdv             NUMERIC(15,2),
        reinstatement   NUMERIC(15,2),
        day1_ltv        NUMERIC(5,2),
        title_number    VARCHAR(50),
        title_doc_id    INT,
        valuation_doc_id INT,
        valuation_date  DATE,
        insurance_doc_id INT,
        insurance_sum   NUMERIC(15,2),
        solicitor_firm  VARCHAR(200),
        solicitor_ref   VARCHAR(100),
        notes           TEXT,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_props_deal ON deal_properties(deal_id);`);

    // Migrate existing users table: update role constraint to include internal staff roles
    try {
      await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('broker', 'borrower', 'admin', 'rm', 'credit', 'compliance'));`);
      console.log('[migrate] Updated users table role constraint (6 roles)');
    } catch (err) {
      console.log('[migrate] Could not update users role constraint:', err.message);
    }

    // Add new columns to deal_submissions if they don't exist
    const columnChecks = [
      { col: 'admin_notes', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS admin_notes TEXT;' },
      { col: 'assigned_to', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id);' },
      { col: 'internal_status', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS internal_status VARCHAR(50) DEFAULT \'new\';' },
      // Phase 1 expanded fields
      { col: 'borrower_dob', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_dob DATE;' },
      { col: 'borrower_nationality', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_nationality VARCHAR(100);' },
      { col: 'borrower_jurisdiction', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_jurisdiction VARCHAR(100);' },
      { col: 'borrower_type', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_type VARCHAR(50);' },
      { col: 'company_name', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS company_name VARCHAR(200);' },
      { col: 'company_number', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS company_number VARCHAR(50);' },
      { col: 'drawdown_date', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS drawdown_date DATE;' },
      { col: 'interest_servicing', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS interest_servicing VARCHAR(30);' },
      { col: 'existing_charges', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS existing_charges TEXT;' },
      { col: 'property_tenure', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS property_tenure VARCHAR(30);' },
      { col: 'occupancy_status', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS occupancy_status VARCHAR(30);' },
      { col: 'current_use', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS current_use VARCHAR(50);' },
      { col: 'purchase_price', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(15,2);' },
      { col: 'use_of_funds', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS use_of_funds TEXT;' },
      { col: 'refurb_scope', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS refurb_scope TEXT;' },
      { col: 'refurb_cost', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS refurb_cost NUMERIC(15,2);' },
      { col: 'deposit_source', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS deposit_source TEXT;' },
      { col: 'concurrent_transactions', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS concurrent_transactions TEXT;' },
      // Phase 2 onboarding (stored as JSONB for flexibility)
      { col: 'onboarding_data', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS onboarding_data JSONB DEFAULT \'{}\'::jsonb;' },
      // Deal stage tracking
      { col: 'deal_stage', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS deal_stage VARCHAR(30) DEFAULT \'received\';' },
      { col: 'termsheet_signed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS termsheet_signed_at TIMESTAMPTZ;' },
      { col: 'commitment_fee_received', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS commitment_fee_received BOOLEAN DEFAULT FALSE;' },
      // RM & approval chain fields
      { col: 'assigned_rm', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_rm INT REFERENCES users(id);' },
      { col: 'assigned_credit', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_credit INT REFERENCES users(id);' },
      { col: 'assigned_compliance', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_compliance INT REFERENCES users(id);' },
      { col: 'dip_fee_confirmed', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_fee_confirmed BOOLEAN DEFAULT FALSE;' },
      { col: 'dip_fee_confirmed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_fee_confirmed_at TIMESTAMPTZ;' },
      { col: 'commitment_fee_confirmed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS commitment_fee_confirmed_at TIMESTAMPTZ;' },
      { col: 'rm_recommendation', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS rm_recommendation VARCHAR(20);" },
      { col: 'credit_recommendation', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS credit_recommendation VARCHAR(20);" },
      { col: 'compliance_recommendation', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS compliance_recommendation VARCHAR(20);" },
      { col: 'final_decision', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_decision VARCHAR(20);" },
      { col: 'final_decision_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_decision_by INT REFERENCES users(id);' },
      { col: 'final_decision_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_decision_at TIMESTAMPTZ;' },
      { col: 'submitted_to_credit_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS submitted_to_credit_at TIMESTAMPTZ;' },
      { col: 'submitted_to_compliance_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS submitted_to_compliance_at TIMESTAMPTZ;' },
      // Phase 2 lifecycle & legal tracking
      { col: 'borrower_user_id', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_user_id INT REFERENCES users(id);' },
      { col: 'dip_issued_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_issued_at TIMESTAMPTZ;' },
      { col: 'dip_issued_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_issued_by INT REFERENCES users(id);' },
      { col: 'dip_notes', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_notes TEXT;' },
      { col: 'ai_termsheet_data', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ai_termsheet_data JSONB DEFAULT \'{}\'::jsonb;' },
      { col: 'ai_termsheet_generated_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ai_termsheet_generated_at TIMESTAMPTZ;' },
      { col: 'fee_requested_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fee_requested_at TIMESTAMPTZ;' },
      { col: 'fee_requested_amount', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fee_requested_amount NUMERIC(15,2);' },
      { col: 'bank_submitted_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_submitted_at TIMESTAMPTZ;' },
      { col: 'bank_submitted_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_submitted_by INT REFERENCES users(id);' },
      { col: 'bank_reference', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(100);' },
      { col: 'bank_approved_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_approved_at TIMESTAMPTZ;' },
      { col: 'bank_approval_notes', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_approval_notes TEXT;' },
      { col: 'borrower_accepted_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_accepted_at TIMESTAMPTZ;' },
      { col: 'legal_instructed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS legal_instructed_at TIMESTAMPTZ;' },
      { col: 'lawyer_firm', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_firm VARCHAR(200);' },
      { col: 'lawyer_email', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_email VARCHAR(255);' },
      { col: 'lawyer_contact', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_contact VARCHAR(30);' },
      { col: 'lawyer_reference', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_reference VARCHAR(100);' },
      { col: 'completed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;' },
      { col: 'borrower_invited_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_invited_at TIMESTAMPTZ;' },
      { col: 'borrower_invite_email', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_invite_email VARCHAR(255);' }
    ];

    for (const check of columnChecks) {
      try {
        await pool.query(check.sql);
        console.log(`[migrate] Ensured column ${check.col} exists`);
      } catch (err) {
        // Column may already exist or migration already ran
        console.log(`[migrate] Note on ${check.col}:`, err.message.substring(0, 60));
      }
    }

    // Indexes for columns added via ALTER TABLE (must run AFTER column additions)
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_internal ON deal_submissions(internal_status);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_assigned ON deal_submissions(assigned_to);`);
    } catch (err) {
      console.log('[migrate] Index creation note:', err.message.substring(0, 80));
    }

    // Add default_rm column to broker_onboarding if it doesn't exist
    try {
      await pool.query(`ALTER TABLE broker_onboarding ADD COLUMN IF NOT EXISTS default_rm INT REFERENCES users(id);`);
      console.log('[migrate] Ensured broker_onboarding.default_rm exists');
    } catch (err) {
      console.log('[migrate] Note on broker_onboarding.default_rm:', err.message.substring(0, 60));
    }

    // Fix deal_stage default and migrate old 'dip' stage to 'received'
    try {
      await pool.query(`ALTER TABLE deal_submissions ALTER COLUMN deal_stage SET DEFAULT 'received';`);
      await pool.query(`UPDATE deal_submissions SET deal_stage = 'received' WHERE deal_stage = 'dip' OR deal_stage IS NULL;`);
      console.log('[migrate] Fixed deal_stage default to received and migrated old dip stages');
    } catch (err) {
      console.log('[migrate] Note on deal_stage fix:', err.message.substring(0, 60));
    }

    // Widen columns that may be too short for AI-extracted data
    try {
      await pool.query(`ALTER TABLE deal_submissions ALTER COLUMN loan_purpose TYPE TEXT;`);
      console.log('[migrate] Widened loan_purpose to TEXT');
    } catch (err) {
      console.log('[migrate] Note on loan_purpose:', err.message.substring(0, 60));
    }

    // Update deal_submissions status constraint to support new deal stages
    try {
      await pool.query(`ALTER TABLE deal_submissions DROP CONSTRAINT IF EXISTS deal_submissions_status_check;`);
      await pool.query(`ALTER TABLE deal_submissions ADD CONSTRAINT deal_submissions_status_check
        CHECK (status IN ('received','assigned','dip_issued','info_gathering','ai_termsheet','fee_pending','fee_paid','underwriting','bank_submitted','bank_approved','borrower_accepted','legal_instructed','completed','declined','withdrawn'));`);
      console.log('[migrate] Updated deal_submissions status constraint with new stages');
    } catch (err) {
      console.log('[migrate] Note on deal status constraint:', err.message.substring(0, 80));
    }

    console.log('[migrate] All tables and indexes created/updated successfully');
  } catch (err) {
    console.error('[migrate] Migration failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE: AUTHENTICATE TOKEN
// ═══════════════════════════════════════════════════════════════════════════
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE: AUTHENTICATE ADMIN
// ═══════════════════════════════════════════════════════════════════════════
function authenticateAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
//  MIDDLEWARE: AUTHENTICATE INTERNAL STAFF (admin, rm, credit, compliance)
// ═══════════════════════════════════════════════════════════════════════════
const INTERNAL_ROLES = ['admin', 'rm', 'credit', 'compliance'];
function authenticateInternal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!INTERNAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Internal staff access required' });
  }
  next();
}

// Helper: log an audit entry
async function logAudit(dealId, action, fromVal, toVal, details, performedBy) {
  try {
    await pool.query(
      `INSERT INTO deal_audit_log (deal_id, action, from_value, to_value, details, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [dealId, action, fromVal || null, toVal || null, details ? JSON.stringify(details) : null, performedBy]
    );
  } catch (err) {
    console.error('[audit] Failed to log:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MICROSOFT GRAPH HELPERS
// ═══════════════════════════════════════════════════════════════════════════
async function getGraphToken() {
  try {
    const tokenUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token request failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.access_token;
  } catch (err) {
    console.error('[onedrive] Token fetch failed:', err.message);
    throw err;
  }
}

async function uploadFileToOneDrive(token, dealRef, filename, fileBuffer) {
  try {
    const encodedFilename = encodeURIComponent(filename);
    const uploadUrl = `https://graph.microsoft.com/v1.0/users/sk@daksfirst.com/drive/root:/Daksfirst Deals/${dealRef}/${encodedFilename}:/content`;

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream'
      },
      body: fileBuffer
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed: ${response.status} ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    return {
      itemId: data.id,
      path: data.parentReference?.path,
      downloadUrl: data.webUrl
    };
  } catch (err) {
    console.error('[onedrive] Upload failed:', err.message);
    throw err;
  }
}

// ── Send Email via Microsoft Graph API ─────────────────────────────────────
async function sendEmailViaGraph({ to, subject, htmlBody }) {
  try {
    const token = await getGraphToken();
    const sendUrl = 'https://graph.microsoft.com/v1.0/users/portal@daksfirst.com/sendMail';

    const response = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          subject: subject,
          body: { contentType: 'HTML', content: htmlBody },
          toRecipients: [{ emailAddress: { address: to } }],
          from: { emailAddress: { address: 'portal@daksfirst.com', name: 'Daksfirst Limited' } }
        },
        saveToSentItems: true
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph sendMail failed: ${response.status} ${text}`);
    }

    console.log('[email] Sent via Graph API to:', to);
    return true;
  } catch (err) {
    console.error('[email] Graph sendMail error:', err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEED ADMIN (one-time use — remove after first admin is created)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/seed-admin', async (req, res) => {
  try {
    const { secret } = req.body;
    if (secret !== 'daksfirst-seed-2026') return res.status(403).json({ error: 'Invalid seed secret' });

    // Check if admin already exists
    const existing = await pool.query("SELECT id FROM users WHERE email = 'sk@daksfirst.com'");
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Admin account already exists' });
    }

    const hashedPassword = await bcrypt.hash('Dax@2026', 12);
    const result = await pool.query(
      `INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
       VALUES ('admin', 'Sumit', 'Kanthed', 'sk@daksfirst.com', '+44000000000', $1, true)
       RETURNING id, email, role`,
      [hashedPassword]
    );
    console.log('[seed] Admin created:', result.rows[0]);
    res.status(201).json({ success: true, message: 'Admin account created', user: result.rows[0] });
  } catch (error) {
    console.error('[seed] Error:', error);
    res.status(500).json({ error: 'Failed to create admin' });
  }
});

// Reset admin password (one-time use — remove after use)
app.post('/api/reset-admin', async (req, res) => {
  try {
    const { secret } = req.body;
    if (secret !== 'daksfirst-seed-2026') return res.status(403).json({ error: 'Invalid secret' });
    const hashedPassword = await bcrypt.hash('Dax@2026', 12);
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, role = 'admin', email_verified = true
       WHERE email = 'sk@daksfirst.com' RETURNING id, email, role`,
      [hashedPassword]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Admin not found' });
    res.json({ success: true, message: 'Admin password reset', user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset admin' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (e) { /* ignore */ }
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    database: dbOk ? 'connected' : 'disconnected',
    webhook: N8N_WEBHOOK_URL ? 'configured' : 'not configured',
    onedrive: (AZURE_CLIENT_ID && AZURE_TENANT_ID && AZURE_CLIENT_SECRET) ? 'configured' : 'not configured'
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  USER REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('[register] Attempt:', { ...req.body, password: '[HIDDEN]' });
    const {
      role, first_name, last_name, email, phone,
      company, fca_number, loan_purpose, loan_amount,
      source, password
    } = req.body;

    // Validation
    if (!role || !first_name || !last_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!['broker', 'borrower'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Only broker or borrower registration is allowed.' });
    }

    // Check existing
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email address already registered' });
    }

    // Hash + token
    const hashedPassword = await bcrypt.hash(password, 12);
    const verificationToken = jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '24h' });

    // Insert
    const result = await pool.query(`
      INSERT INTO users (role, first_name, last_name, email, phone, company, fca_number,
                         loan_purpose, loan_amount, source, password_hash, verification_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, email, first_name, last_name, role
    `, [
      role, first_name, last_name, email.toLowerCase(), phone,
      company || null, fca_number || null, loan_purpose || null,
      loan_amount || null, source || 'portal', hashedPassword, verificationToken
    ]);

    const newUser = result.rows[0];
    console.log('[register] Created:', newUser.id, newUser.email, 'role:', newUser.role);

    // Send verification email via Graph API (non-blocking)
    try {
      const verificationUrl = `https://apply.daksfirst.com/verify?token=${verificationToken}`;
      await sendEmailViaGraph({
        to: email,
        subject: 'Verify Your Daksfirst Account',
        htmlBody: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#1a365d;">Welcome to Daksfirst</h2>
            <p>Hello ${first_name},</p>
            <p>Thank you for registering with Daksfirst. Please verify your email address to complete your account setup:</p>
            <p style="text-align:center;margin:30px 0;">
              <a href="${verificationUrl}" style="background:#c9a84c;color:white;padding:14px 32px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold;font-size:16px;">Verify Email Address</a>
            </p>
            <p>This link expires in 24 hours. If you did not create this account, please ignore this email.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #e2e8f0;">
            <p style="color:#666;font-size:13px;">Daksfirst Limited — Bridging Finance, Built for Professionals<br>West London, United Kingdom</p>
          </div>
        `
      });
      console.log('[register] Verification email sent to:', email);
    } catch (emailErr) {
      console.error('[register] Email failed:', emailErr.message);
      // Registration still succeeds even if email fails
    }

    // Generate login token immediately
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      JWT_SECRET, { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please check your email to verify your account.',
      token,
      user: newUser
    });
  } catch (error) {
    console.error('[register] Error:', error);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  USER LOGIN
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, company, password_hash, email_verified FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, company: user.company || null }
    });
  } catch (error) {
    console.error('[login] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EMAIL VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Verification token is required' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'UPDATE users SET email_verified = true, verification_token = null WHERE email = $1 RETURNING id, email, first_name',
      [decoded.email]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid verification token' });

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    console.error('[verify] Error:', error);
    res.status(400).json({ error: 'Invalid or expired verification token' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEAL SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/deals/submit', authenticateToken, async (req, res) => {
  try {
    console.log('[deal] Submission from user:', req.user.userId);
    const {
      borrower_name, borrower_company, borrower_email, borrower_phone,
      broker_name, broker_company, broker_fca,
      security_address, security_postcode, asset_type, current_value,
      loan_amount, ltv_requested, loan_purpose, exit_strategy,
      term_months, rate_requested, additional_notes, documents,
      borrower_dob, borrower_nationality, borrower_jurisdiction, borrower_type,
      company_name, company_number, drawdown_date, interest_servicing,
      existing_charges, property_tenure, occupancy_status, current_use,
      purchase_price, use_of_funds, refurb_scope, refurb_cost,
      deposit_source, concurrent_transactions, borrower_invite_email
    } = req.body;

    // Validation
    if (!security_address || !loan_amount || !loan_purpose) {
      return res.status(400).json({ error: 'Security address, loan amount and loan purpose are required' });
    }

    // Get broker's default_rm if this is a broker submitting
    let assignedRm = null;
    if (req.user.role === 'broker') {
      const brokerOnb = await pool.query(`SELECT default_rm FROM broker_onboarding WHERE user_id = $1`, [req.user.userId]);
      if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm) {
        assignedRm = brokerOnb.rows[0].default_rm;
      }
    }

    // Insert deal
    const result = await pool.query(`
      INSERT INTO deal_submissions (
        user_id, borrower_name, borrower_company, borrower_email, borrower_phone,
        broker_name, broker_company, broker_fca,
        security_address, security_postcode, asset_type, current_value,
        loan_amount, ltv_requested, loan_purpose, exit_strategy,
        term_months, rate_requested, additional_notes, documents, source, internal_status,
        borrower_dob, borrower_nationality, borrower_jurisdiction, borrower_type,
        company_name, company_number, drawdown_date, interest_servicing,
        existing_charges, property_tenure, occupancy_status, current_use,
        purchase_price, use_of_funds, refurb_scope, refurb_cost,
        deposit_source, concurrent_transactions, borrower_invite_email, assigned_rm
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
      RETURNING id, submission_id, status, created_at
    `, [
      req.user.userId,
      borrower_name || null, borrower_company || null, borrower_email || null, borrower_phone || null,
      broker_name || null, broker_company || null, broker_fca || null,
      security_address, security_postcode || null, asset_type || null, current_value || null,
      loan_amount, ltv_requested || null, loan_purpose, exit_strategy || null,
      term_months || null, rate_requested || null, additional_notes || null,
      JSON.stringify(documents || []), 'web_form', 'new',
      borrower_dob || null, borrower_nationality || null, borrower_jurisdiction || null, borrower_type || null,
      company_name || null, company_number || null, drawdown_date || null, interest_servicing || null,
      existing_charges || null, property_tenure || null, occupancy_status || null, current_use || null,
      purchase_price || null, use_of_funds || null, refurb_scope || null, refurb_cost || null,
      deposit_source || null, concurrent_transactions || null,
      borrower_invite_email || null, assignedRm || null
    ]);

    const deal = result.rows[0];
    console.log('[deal] Created:', deal.submission_id);

    // Log audit trail
    await logAudit(deal.id, 'deal_submitted', null, 'received',
      { submitted_by: req.user.userId, loan_amount, security_address, assigned_rm: assignedRm }, req.user.userId);

    res.status(201).json({
      success: true,
      message: 'Deal submitted successfully. Our team will review it shortly.',
      deal: {
        id: deal.id,
        submission_id: deal.submission_id,
        status: deal.status,
        created_at: deal.created_at
      }
    });
  } catch (error) {
    console.error('[deal] Error:', error);
    res.status(500).json({ error: 'Failed to submit deal. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET USER'S DEALS (Dashboard)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/deals', authenticateToken, async (req, res) => {
  try {
    // Broker/internal: see deals they submitted or are assigned to
    // Borrower: see deals assigned to them
    let query, params;

    if (req.user.role === 'borrower') {
      query = `SELECT ds.id, ds.submission_id, ds.status, ds.borrower_name, ds.security_address,
                      ds.loan_amount, ds.loan_purpose, ds.asset_type, ds.created_at, ds.updated_at,
                      COUNT(dd.id) as document_count
               FROM deal_submissions ds
               LEFT JOIN deal_documents dd ON ds.id = dd.deal_id
               WHERE ds.borrower_user_id = $1
               GROUP BY ds.id
               ORDER BY ds.created_at DESC`;
      params = [req.user.userId];
    } else {
      query = `SELECT ds.id, ds.submission_id, ds.status, ds.borrower_name, ds.security_address,
                      ds.loan_amount, ds.loan_purpose, ds.asset_type, ds.created_at, ds.updated_at,
                      COUNT(dd.id) as document_count
               FROM deal_submissions ds
               LEFT JOIN deal_documents dd ON ds.id = dd.deal_id
               WHERE ds.user_id = $1
               GROUP BY ds.id
               ORDER BY ds.created_at DESC`;
      params = [req.user.userId];
    }

    const result = await pool.query(query, params);
    res.json({ success: true, deals: result.rows });
  } catch (error) {
    console.error('[deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET SINGLE DEAL (Dashboard)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/deals/:submissionId', authenticateToken, async (req, res) => {
  try {
    // Broker/internal: see deals they submitted or are assigned to
    // Borrower: see deals assigned to them
    let dealResult;

    if (req.user.role === 'borrower') {
      dealResult = await pool.query(
        `SELECT * FROM deal_submissions WHERE submission_id = $1 AND borrower_user_id = $2`,
        [req.params.submissionId, req.user.userId]
      );
    } else {
      dealResult = await pool.query(
        `SELECT * FROM deal_submissions WHERE submission_id = $1 AND user_id = $2`,
        [req.params.submissionId, req.user.userId]
      );
    }

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // Get documents
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at
       FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at DESC`,
      [dealId]
    );

    // Get analysis results
    const analysisResult = await pool.query(
      `SELECT credit_memo_url, termsheet_url, gbb_memo_url, analysis_json, completed_at
       FROM analysis_results WHERE deal_id = $1`,
      [dealId]
    );

    res.json({
      success: true,
      deal: {
        ...deal,
        documents: docsResult.rows,
        analysis: analysisResult.rows[0] || null
      }
    });
  } catch (error) {
    console.error('[deal-detail] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deal details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE DEAL STATUS (from webhook callback)
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/deals/:submissionId/status', authenticateToken, async (req, res) => {
  try {
    const { status, internal_status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const result = await pool.query(
      `UPDATE deal_submissions
       SET status = $1, internal_status = COALESCE($2, internal_status), updated_at = NOW()
       WHERE submission_id = $3 AND user_id = $4
       RETURNING id, submission_id, status, updated_at`,
      [status, internal_status || null, req.params.submissionId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    console.log('[deal-update] Deal', req.params.submissionId, 'status updated to', status);
    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[deal-update] Error:', error);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SAVE ONBOARDING DATA (Phase 2 — per tab)
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/deals/:submissionId/onboarding', authenticateToken, async (req, res) => {
  try {
    const { tab, data } = req.body;
    if (!tab || !data) return res.status(400).json({ error: 'Tab name and data are required' });

    // Valid Phase 2 tabs
    const validTabs = ['kyc', 'financials', 'valuation', 'refurbishment', 'exit_evidence', 'aml', 'insurance'];
    if (!validTabs.includes(tab)) return res.status(400).json({ error: 'Invalid onboarding tab' });

    // Get the deal
    const dealResult = await pool.query(
      'SELECT id, onboarding_data, deal_stage FROM deal_submissions WHERE submission_id = $1 AND user_id = $2',
      [req.params.submissionId, req.user.userId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = dealResult.rows[0];

    // Check if Phase 2 is unlocked (termsheet must be signed)
    const unlockedStages = ['termsheet_signed', 'underwriting', 'approved', 'legal', 'completed'];
    if (!unlockedStages.includes(deal.deal_stage)) {
      return res.status(403).json({ error: 'Onboarding is not yet available. Termsheet must be signed first.' });
    }

    // Merge the tab data into onboarding_data JSONB
    const currentData = deal.onboarding_data || {};
    currentData[tab] = { ...data, updated_at: new Date().toISOString() };

    await pool.query(
      'UPDATE deal_submissions SET onboarding_data = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(currentData), deal.id]
    );

    console.log(`[onboarding] Saved tab '${tab}' for deal ${req.params.submissionId}`);
    res.json({ success: true, message: `${tab} data saved successfully` });
  } catch (error) {
    console.error('[onboarding] Error:', error);
    res.status(500).json({ error: 'Failed to save onboarding data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  UPDATE DEAL STAGE (Admin only)
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/admin/deals/:submissionId/stage', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { stage } = req.body;
    const validStages = ['dip', 'dip_issued', 'termsheet_sent', 'termsheet_signed', 'underwriting', 'approved', 'legal', 'funds_released', 'declined', 'withdrawn'];
    if (!validStages.includes(stage)) return res.status(400).json({ error: 'Invalid deal stage' });

    const updates = ['deal_stage = $1', 'updated_at = NOW()'];
    const values = [stage];

    if (stage === 'termsheet_signed') {
      updates.push('termsheet_signed_at = NOW()');
    }

    const result = await pool.query(
      `UPDATE deal_submissions SET ${updates.join(', ')} WHERE submission_id = $${values.length + 1} RETURNING id, submission_id, deal_stage`,
      [...values, req.params.submissionId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    console.log(`[admin] Deal ${req.params.submissionId} stage updated to: ${stage}`);
    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[admin-stage] Error:', error);
    res.status(500).json({ error: 'Failed to update deal stage' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  FILE UPLOAD TO ONEDRIVE
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/deals/:dealId/upload', authenticateToken, upload.any(), async (req, res) => {
  try {
    console.log('[upload] File upload to deal:', req.params.dealId, 'files:', req.files?.length || 0);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Verify deal ownership
    const dealResult = await pool.query(
      `SELECT id, submission_id FROM deal_submissions WHERE id = $1 AND user_id = $2`,
      [req.params.dealId, req.user.userId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found or access denied' });
    }

    const deal = dealResult.rows[0];
    const dealRef = deal.submission_id.substring(0, 8); // Use first 8 chars of UUID for path

    // Get OneDrive token
    let token;
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[upload] Could not get OneDrive token:', err.message);
      return res.status(503).json({
        error: 'OneDrive service unavailable. Files may not be uploaded to cloud storage, but submission continues.'
      });
    }

    // Upload each file
    const uploadedDocs = [];
    const uploadErrors = [];

    for (const file of req.files) {
      try {
        const oneDriveInfo = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);

        // Store reference in DB
        const docResult = await pool.query(
          `INSERT INTO deal_documents
           (deal_id, filename, file_type, file_size, onedrive_item_id, onedrive_path, onedrive_download_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, filename, file_size, uploaded_at`,
          [
            req.params.dealId,
            file.originalname,
            file.mimetype,
            file.size,
            oneDriveInfo.itemId,
            oneDriveInfo.path,
            oneDriveInfo.downloadUrl
          ]
        );

        uploadedDocs.push(docResult.rows[0]);
        console.log('[upload] File uploaded:', file.originalname);
      } catch (err) {
        console.error('[upload] Failed to upload', file.originalname, ':', err.message);
        uploadErrors.push({ filename: file.originalname, error: err.message });
      }
    }

    if (uploadedDocs.length === 0) {
      return res.status(400).json({
        error: 'Failed to upload any files',
        details: uploadErrors
      });
    }

    res.json({
      success: true,
      message: `${uploadedDocs.length} file(s) uploaded successfully`,
      documents: uploadedDocs,
      errors: uploadErrors.length > 0 ? uploadErrors : undefined
    });
  } catch (error) {
    console.error('[upload] Error:', error);
    res.status(500).json({ error: 'File upload failed. Please try again.' });
  }
});

// Internal staff file upload (admin can upload to any deal by ID)
app.post('/api/admin/deals/:dealId/upload', authenticateToken, authenticateInternal, upload.any(), async (req, res) => {
  try {
    console.log('[admin-upload] File upload to deal:', req.params.dealId, 'files:', req.files?.length || 0);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    // Verify deal exists (internal can access any deal)
    const dealResult = await pool.query(
      `SELECT id, submission_id FROM deal_submissions WHERE id = $1`,
      [req.params.dealId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const dealRef = deal.submission_id.substring(0, 8);

    // Get OneDrive token
    let token;
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[admin-upload] Could not get OneDrive token:', err.message);
      return res.status(503).json({
        error: 'OneDrive service unavailable. Files may not be uploaded to cloud storage.'
      });
    }

    // Upload each file
    const uploadedDocs = [];
    const uploadErrors = [];

    for (const file of req.files) {
      try {
        const oneDriveInfo = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);

        const docResult = await pool.query(
          `INSERT INTO deal_documents
           (deal_id, filename, file_type, file_size, onedrive_item_id, onedrive_path, onedrive_download_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, filename, file_size, uploaded_at`,
          [
            req.params.dealId,
            file.originalname,
            file.mimetype,
            file.size,
            oneDriveInfo.itemId,
            oneDriveInfo.path,
            oneDriveInfo.downloadUrl
          ]
        );

        uploadedDocs.push(docResult.rows[0]);
        await logAudit(req.params.dealId, 'document_uploaded', null, file.originalname,
          { uploaded_by: req.user.userId, file_type: file.mimetype }, req.user.userId);

        console.log('[admin-upload] File uploaded:', file.originalname);
      } catch (err) {
        console.error('[admin-upload] Failed to upload', file.originalname, ':', err.message);
        uploadErrors.push({ filename: file.originalname, error: err.message });
      }
    }

    if (uploadedDocs.length === 0) {
      return res.status(400).json({
        error: 'Failed to upload any files',
        details: uploadErrors
      });
    }

    res.json({
      success: true,
      message: `${uploadedDocs.length} file(s) uploaded successfully by internal staff`,
      documents: uploadedDocs,
      errors: uploadErrors.length > 0 ? uploadErrors : undefined
    });
  } catch (error) {
    console.error('[admin-upload] Error:', error);
    res.status(500).json({ error: 'File upload failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET DEAL DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/deals/:dealId/documents', authenticateToken, async (req, res) => {
  try {
    // Verify ownership
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE id = $1 AND user_id = $2`,
      [req.params.dealId, req.user.userId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const result = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at
       FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.dealId]
    );

    res.json({ success: true, documents: result.rows });
  } catch (error) {
    console.error('[docs] Error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ANALYSIS WEBHOOK CALLBACK (from n8n)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/webhook/analysis-complete', async (req, res) => {
  try {
    const { submissionId, creditMemoUrl, termsheetUrl, gbbMemoUrl, analysisJson } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    console.log('[webhook-analysis] Analysis complete for:', submissionId);

    // Get deal ID from submission_id
    const dealResult = await pool.query(
      `SELECT id FROM deal_submissions WHERE submission_id = $1`,
      [submissionId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const dealId = dealResult.rows[0].id;

    // Store analysis results
    await pool.query(
      `INSERT INTO analysis_results (deal_id, credit_memo_url, termsheet_url, gbb_memo_url, analysis_json)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (deal_id) DO UPDATE SET
         credit_memo_url = EXCLUDED.credit_memo_url,
         termsheet_url = EXCLUDED.termsheet_url,
         gbb_memo_url = EXCLUDED.gbb_memo_url,
         analysis_json = EXCLUDED.analysis_json,
         completed_at = NOW()`,
      [dealId, creditMemoUrl || null, termsheetUrl || null, gbbMemoUrl || null, analysisJson || null]
    );

    // Update deal status
    await pool.query(
      `UPDATE deal_submissions SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [dealId]
    );

    console.log('[webhook-analysis] Analysis stored for deal:', dealId);
    res.json({ success: true, message: 'Analysis results stored' });
  } catch (error) {
    console.error('[webhook-analysis] Error:', error);
    res.status(500).json({ error: 'Failed to store analysis results' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET ALL DEALS (with pagination & filtering)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/deals', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, asset_type, broker, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `SELECT ds.id, ds.submission_id, ds.status, ds.deal_stage,
                        ds.borrower_name, ds.borrower_company, ds.borrower_type,
                        ds.broker_name, ds.broker_company,
                        ds.loan_amount, ds.current_value, ds.purchase_price, ds.ltv_requested,
                        ds.security_address, ds.security_postcode,
                        ds.asset_type, ds.term_months, ds.rate_requested, ds.exit_strategy,
                        ds.interest_servicing, ds.loan_purpose,
                        ds.drawdown_date, ds.created_at, ds.updated_at,
                        ds.assigned_rm, ds.assigned_credit, ds.assigned_compliance,
                        ds.internal_status, ds.dip_fee_confirmed, ds.commitment_fee_received,
                        ds.fee_requested_amount, ds.fee_requested_at,
                        ds.dip_issued_at, ds.bank_submitted_at, ds.bank_approved_at,
                        ds.rm_recommendation, ds.credit_recommendation, ds.compliance_recommendation, ds.final_decision,
                        rm.first_name as rm_first, rm.last_name as rm_last,
                        cr.first_name as credit_first, cr.last_name as credit_last,
                        co.first_name as comp_first, co.last_name as comp_last,
                        u.first_name as submitter_first, u.last_name as submitter_last
                 FROM deal_submissions ds
                 LEFT JOIN users rm ON ds.assigned_rm = rm.id
                 LEFT JOIN users cr ON ds.assigned_credit = cr.id
                 LEFT JOIN users co ON ds.assigned_compliance = co.id
                 LEFT JOIN users u ON ds.user_id = u.id
                 WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` AND ds.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }
    if (asset_type) {
      query += ` AND ds.asset_type = $${paramCount}`;
      params.push(asset_type);
      paramCount++;
    }
    if (broker) {
      query += ` AND ds.broker_company ILIKE $${paramCount}`;
      params.push(`%${broker}%`);
      paramCount++;
    }

    query += ` ORDER BY ds.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM deal_submissions WHERE 1=1`;
    const countParams = [];
    let countParamCount = 1;

    if (status) {
      countQuery += ` AND status = $${countParamCount}`;
      countParams.push(status);
      countParamCount++;
    }
    if (asset_type) {
      countQuery += ` AND asset_type = $${countParamCount}`;
      countParams.push(asset_type);
      countParamCount++;
    }
    if (broker) {
      countQuery += ` AND broker_company ILIKE $${countParamCount}`;
      countParams.push(`%${broker}%`);
      countParamCount++;
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = countResult.rows[0].total;

    res.json({
      success: true,
      deals: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[admin-deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET SINGLE DEAL
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/deals/:submissionId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT ds.*,
              u.first_name, u.last_name, u.email as submitter_email,
              rm.first_name as rm_first, rm.last_name as rm_last, rm.email as rm_email,
              cr.first_name as credit_first, cr.last_name as credit_last,
              co.first_name as comp_first, co.last_name as comp_last,
              fd.first_name as decision_first, fd.last_name as decision_last
       FROM deal_submissions ds
       LEFT JOIN users u ON ds.user_id = u.id
       LEFT JOIN users rm ON ds.assigned_rm = rm.id
       LEFT JOIN users cr ON ds.assigned_credit = cr.id
       LEFT JOIN users co ON ds.assigned_compliance = co.id
       LEFT JOIN users fd ON ds.final_decision_by = fd.id
       WHERE ds.submission_id = $1`,
      [req.params.submissionId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const dealId = deal.id;

    // Get documents
    const docsResult = await pool.query(
      `SELECT id, filename, file_type, file_size, uploaded_at FROM deal_documents WHERE deal_id = $1`,
      [dealId]
    );

    // Get analysis
    const analysisResult = await pool.query(
      `SELECT credit_memo_url, termsheet_url, gbb_memo_url, completed_at FROM analysis_results WHERE deal_id = $1`,
      [dealId]
    );

    // Get notes
    const notesResult = await pool.query(
      `SELECT cn.id, cn.note, cn.created_at, u.first_name, u.last_name, u.email
       FROM client_notes cn
       LEFT JOIN users u ON cn.created_by = u.id
       WHERE cn.deal_id = $1 OR (cn.user_id = (SELECT user_id FROM deal_submissions WHERE id = $1))
       ORDER BY cn.created_at DESC`,
      [dealId]
    );

    // Get audit log
    const auditResult = await pool.query(
      `SELECT a.id, a.action, a.from_value, a.to_value, a.details, a.created_at,
              u.first_name, u.last_name, u.role
       FROM deal_audit_log a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.deal_id = $1
       ORDER BY a.created_at DESC LIMIT 50`,
      [dealId]
    );

    // Get fee payments
    const feesResult = await pool.query(
      `SELECT f.id, f.fee_type, f.amount, f.payment_date, f.payment_ref, f.notes, f.created_at,
              u.first_name, u.last_name
       FROM deal_fee_payments f
       LEFT JOIN users u ON f.confirmed_by = u.id
       WHERE f.deal_id = $1
       ORDER BY f.created_at DESC`,
      [dealId]
    );

    // Get approvals
    const approvalsResult = await pool.query(
      `SELECT a.id, a.approval_stage, a.decision, a.comments, a.created_at,
              u.first_name, u.last_name, u.role
       FROM deal_approvals a
       LEFT JOIN users u ON a.decided_by = u.id
       WHERE a.deal_id = $1
       ORDER BY a.created_at DESC`,
      [dealId]
    );

    // Get borrowers
    const borrowersResult = await pool.query(
      `SELECT * FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, created_at`, [dealId]
    );

    // Get properties
    const propertiesResult = await pool.query(
      `SELECT * FROM deal_properties WHERE deal_id = $1 ORDER BY created_at`, [dealId]
    );
    const portfolioSummary = {
      total_properties: propertiesResult.rows.length,
      total_market_value: propertiesResult.rows.reduce((sum, p) => sum + (parseFloat(p.market_value) || 0), 0),
      total_gdv: propertiesResult.rows.reduce((sum, p) => sum + (parseFloat(p.gdv) || 0), 0)
    };

    res.json({
      success: true,
      deal: {
        ...deal,
        documents: docsResult.rows,
        analysis: analysisResult.rows[0] || null,
        notes: notesResult.rows,
        audit: auditResult.rows,
        fees: feesResult.rows,
        approvals: approvalsResult.rows,
        borrowers: borrowersResult.rows,
        properties: propertiesResult.rows,
        portfolio_summary: portfolioSummary
      }
    });
  } catch (error) {
    console.error('[admin-deal-detail] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deal details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: UPDATE DEAL
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/admin/deals/:submissionId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, admin_notes, assigned_to, internal_status } = req.body;

    const result = await pool.query(
      `UPDATE deal_submissions
       SET status = COALESCE($1, status),
           admin_notes = COALESCE($2, admin_notes),
           assigned_to = COALESCE($3, assigned_to),
           internal_status = COALESCE($4, internal_status),
           updated_at = NOW()
       WHERE submission_id = $5
       RETURNING id, submission_id, status, internal_status, assigned_to, updated_at`,
      [status || null, admin_notes || null, assigned_to || null, internal_status || null, req.params.submissionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    console.log('[admin-update] Deal', req.params.submissionId, 'updated by admin', req.user.userId);
    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[admin-update] Error:', error);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET ALL USERS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/users', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { role, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.company,
                        u.role, u.fca_number, u.created_at,
                        COUNT(DISTINCT ds.id) as deal_count
                 FROM users u
                 LEFT JOIN deal_submissions ds ON u.id = ds.user_id
                 WHERE 1=1`;
    const params = [];
    let paramCount = 1;

    if (role) {
      query += ` AND u.role = $${paramCount}`;
      params.push(role);
      paramCount++;
    }

    query += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM users WHERE 1=1`;
    if (role) {
      countQuery += ` AND role = $1`;
    }
    const countResult = await pool.query(countQuery, role ? [role] : []);
    const total = countResult.rows[0].total;

    res.json({
      success: true,
      users: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[admin-users] Error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET USER DETAILS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/users/:userId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, first_name, last_name, email, phone, company, role, fca_number,
              loan_purpose, loan_amount, created_at, email_verified
       FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get user's deals
    const dealsResult = await pool.query(
      `SELECT id, submission_id, status, borrower_name, loan_amount, asset_type, created_at
       FROM deal_submissions WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );

    res.json({
      success: true,
      user: {
        ...user,
        deals: dealsResult.rows
      }
    });
  } catch (error) {
    console.error('[admin-user-detail] Error:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ADD NOTE TO DEAL
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/users/:userId/notes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { deal_id, note } = req.body;

    if (!note) {
      return res.status(400).json({ error: 'Note is required' });
    }

    const result = await pool.query(
      `INSERT INTO client_notes (user_id, deal_id, note, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, note, created_at`,
      [req.params.userId, deal_id || null, note, req.user.userId]
    );

    console.log('[admin-note] Note added by admin', req.user.userId, 'for user', req.params.userId);
    res.status(201).json({ success: true, note: result.rows[0] });
  } catch (error) {
    console.error('[admin-note] Error:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    // Total deals by status
    const statusResult = await pool.query(
      `SELECT status, COUNT(*) as count FROM deal_submissions GROUP BY status`
    );

    // Total users
    const userResult = await pool.query(
      `SELECT role, COUNT(*) as count FROM users WHERE role IN ('broker', 'borrower') GROUP BY role`
    );

    // Deals by month (last 12 months)
    const monthResult = await pool.query(
      `SELECT DATE_TRUNC('month', created_at)::DATE as month, COUNT(*) as count
       FROM deal_submissions
       WHERE created_at > NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', created_at)
       ORDER BY month DESC`
    );

    // Average LTV
    const ltvResult = await pool.query(
      `SELECT AVG(ltv_requested) as avg_ltv, MIN(ltv_requested) as min_ltv, MAX(ltv_requested) as max_ltv
       FROM deal_submissions WHERE ltv_requested IS NOT NULL`
    );

    // Approval rate (completed / total)
    const approvalResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') as approved,
         COUNT(*) as total
       FROM deal_submissions WHERE status IN ('completed', 'declined')`
    );

    const totalDeals = statusResult.rows.reduce((sum, r) => sum + parseInt(r.count), 0);

    res.json({
      success: true,
      stats: {
        totalDeals,
        byStatus: statusResult.rows,
        byUserRole: userResult.rows,
        byMonth: monthResult.rows,
        ltv: ltvResult.rows[0],
        approvalRate: approvalResult.rows[0].total > 0
          ? (approvalResult.rows[0].approved / approvalResult.rows[0].total * 100).toFixed(2)
          : 0
      }
    });
  } catch (error) {
    console.error('[admin-stats] Error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: CREATE INTERNAL USER (admin, rm, credit, compliance)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/create', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, password, role } = req.body;
    const userRole = role || 'admin';

    if (!first_name || !last_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!INTERNAL_ROLES.includes(userRole)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, rm, credit, or compliance.' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email address already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, email, first_name, last_name, role`,
      [userRole, first_name, last_name, email.toLowerCase(), phone, hashedPassword]
    );

    const newUser = result.rows[0];
    console.log(`[admin-create] New ${userRole} created:`, newUser.id, newUser.email, 'by', req.user.userId);

    res.status(201).json({ success: true, message: `${userRole.toUpperCase()} user created successfully`, user: newUser });
  } catch (error) {
    console.error('[admin-create] Error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ASSIGN DEAL TO RM
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/admin/deals/:submissionId/assign', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { rm_id } = req.body;
    if (!rm_id) return res.status(400).json({ error: 'RM user ID is required' });

    // Verify the user is an RM (not a broker or borrower)
    const rmCheck = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE id = $1', [rm_id]);
    if (rmCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (!['rm', 'admin'].includes(rmCheck.rows[0].role)) {
      return res.status(400).json({ error: 'Can only assign deals to RM or Admin staff. Brokers and borrowers cannot be assigned deals.' });
    }

    const dealResult = await pool.query(
      `SELECT id, assigned_rm FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = dealResult.rows[0];
    const oldRm = deal.assigned_rm;
    const rm = rmCheck.rows[0];

    await pool.query(
      `UPDATE deal_submissions SET assigned_rm = $1, assigned_to = $1, deal_stage = CASE WHEN deal_stage IN ('received', 'dip') THEN 'assigned' ELSE deal_stage END, updated_at = NOW() WHERE id = $2`,
      [rm_id, deal.id]
    );

    await logAudit(deal.id, 'deal_assigned_to_rm', oldRm ? String(oldRm) : null, String(rm_id),
      { rm_name: `${rm.first_name} ${rm.last_name}`, assigned_by: req.user.userId }, req.user.userId);

    res.json({ success: true, message: `Deal assigned to ${rm.first_name} ${rm.last_name}` });
  } catch (error) {
    console.error('[assign-rm] Error:', error);
    res.status(500).json({ error: 'Failed to assign deal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: GET INTERNAL STAFF LIST (for assignment dropdowns)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/staff', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { role } = req.query;
    let query = `SELECT id, first_name, last_name, email, role FROM users WHERE role IN ('admin', 'rm', 'credit', 'compliance')`;
    const params = [];
    if (role) {
      query += ` AND role = $1`;
      params.push(role);
    }
    query += ` ORDER BY first_name`;
    const result = await pool.query(query, params);
    res.json({ success: true, staff: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  RM: CONFIRM FEE PAYMENT (DIP fee or commitment fee)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/deals/:submissionId/fee', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { fee_type, amount, payment_date, payment_ref, notes } = req.body;
    if (!fee_type || !amount || !payment_date) {
      return res.status(400).json({ error: 'Fee type, amount, and payment date are required' });
    }
    if (!['dip_fee', 'commitment_fee', 'arrangement_fee', 'legal_fee', 'valuation_fee', 'other'].includes(fee_type)) {
      return res.status(400).json({ error: 'Invalid fee type' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, assigned_rm FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Only the assigned RM or admin can confirm fees
    if (req.user.role === 'rm' && deal.assigned_rm !== req.user.userId) {
      return res.status(403).json({ error: 'Only the assigned RM can confirm fees for this deal' });
    }

    // Record the payment
    await pool.query(
      `INSERT INTO deal_fee_payments (deal_id, fee_type, amount, payment_date, payment_ref, notes, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [deal.id, fee_type, amount, payment_date, payment_ref || null, notes || null, req.user.userId]
    );

    // Update deal flags
    if (fee_type === 'dip_fee') {
      await pool.query(`UPDATE deal_submissions SET dip_fee_confirmed = true, dip_fee_confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`, [deal.id]);
    }
    if (fee_type === 'commitment_fee') {
      await pool.query(`UPDATE deal_submissions SET commitment_fee_received = true, commitment_fee_confirmed_at = NOW(), updated_at = NOW() WHERE id = $1`, [deal.id]);
    }

    await logAudit(deal.id, `fee_confirmed_${fee_type}`, null, String(amount),
      { fee_type, amount, payment_date, payment_ref, confirmed_by: req.user.userId }, req.user.userId);

    res.json({ success: true, message: `${fee_type.replace('_', ' ')} of £${amount} confirmed` });
  } catch (error) {
    console.error('[fee] Error:', error);
    res.status(500).json({ error: 'Failed to confirm fee' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  RM: ADVANCE DEAL STAGE
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/deals/:submissionId/stage', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { new_stage, comments } = req.body;
    const validStages = ['dip', 'dip_issued', 'termsheet_sent', 'termsheet_signed', 'underwriting', 'credit_review', 'compliance_review', 'approved', 'legal', 'funds_released', 'declined', 'withdrawn'];
    if (!validStages.includes(new_stage)) {
      return res.status(400).json({ error: 'Invalid stage' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, assigned_rm FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];
    const oldStage = deal.deal_stage;

    // Only assigned RM or admin can advance stage
    if (req.user.role === 'rm' && deal.assigned_rm !== req.user.userId) {
      return res.status(403).json({ error: 'Only the assigned RM can advance this deal' });
    }

    // Business rules
    if (new_stage === 'underwriting' && !deal.dip_fee_confirmed) {
      // Check if DIP fee has been confirmed
      const feeCheck = await pool.query(`SELECT dip_fee_confirmed FROM deal_submissions WHERE id = $1`, [deal.id]);
      if (!feeCheck.rows[0].dip_fee_confirmed) {
        return res.status(400).json({ error: 'DIP fee must be confirmed before moving to underwriting' });
      }
    }

    // Final approval can only be done by admin
    if (['approved', 'declined'].includes(new_stage) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only Admin can make the final lending decision' });
    }

    const updateFields = { deal_stage: new_stage, updated_at: 'NOW()' };
    if (new_stage === 'termsheet_signed') updateFields.termsheet_signed_at = 'NOW()';
    if (new_stage === 'underwriting') updateFields.submitted_to_credit_at = 'NOW()';

    await pool.query(
      `UPDATE deal_submissions SET deal_stage = $1,
       termsheet_signed_at = CASE WHEN $1 = 'termsheet_signed' THEN NOW() ELSE termsheet_signed_at END,
       submitted_to_credit_at = CASE WHEN $1 = 'underwriting' THEN NOW() ELSE submitted_to_credit_at END,
       submitted_to_compliance_at = CASE WHEN $1 = 'compliance_review' THEN NOW() ELSE submitted_to_compliance_at END,
       final_decision = CASE WHEN $1 IN ('approved', 'declined') THEN $1 ELSE final_decision END,
       final_decision_by = CASE WHEN $1 IN ('approved', 'declined') THEN $2 ELSE final_decision_by END,
       final_decision_at = CASE WHEN $1 IN ('approved', 'declined') THEN NOW() ELSE final_decision_at END,
       status = CASE WHEN $1 = 'approved' THEN 'completed' WHEN $1 = 'declined' THEN 'declined' ELSE status END,
       updated_at = NOW()
       WHERE id = $3`,
      [new_stage, req.user.userId, deal.id]
    );

    await logAudit(deal.id, 'stage_advanced', oldStage, new_stage,
      { comments, advanced_by: req.user.userId, role: req.user.role }, req.user.userId);

    res.json({ success: true, message: `Deal stage updated to ${new_stage}`, from: oldStage, to: new_stage });
  } catch (error) {
    console.error('[stage] Error:', error);
    res.status(500).json({ error: 'Failed to update deal stage' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CREDIT/COMPLIANCE: SUBMIT RECOMMENDATION
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/deals/:submissionId/recommendation', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { decision, comments } = req.body;
    if (!['approve', 'decline', 'more_info'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approve, decline, or more_info' });
    }

    const dealResult = await pool.query(
      `SELECT id, deal_stage, assigned_credit, assigned_compliance FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    let approvalStage = '';
    let updateCol = '';

    if (req.user.role === 'rm') {
      approvalStage = 'rm_recommendation';
      updateCol = 'rm_recommendation';
    } else if (req.user.role === 'credit') {
      approvalStage = 'credit_review';
      updateCol = 'credit_recommendation';
      if (deal.assigned_credit && deal.assigned_credit !== req.user.userId) {
        return res.status(403).json({ error: 'You are not the assigned Credit Analyst for this deal' });
      }
    } else if (req.user.role === 'compliance') {
      approvalStage = 'compliance_review';
      updateCol = 'compliance_recommendation';
      if (deal.assigned_compliance && deal.assigned_compliance !== req.user.userId) {
        return res.status(403).json({ error: 'You are not the assigned Compliance officer for this deal' });
      }
    } else if (req.user.role === 'admin') {
      // Admin can act as any role
      approvalStage = req.body.stage || 'admin_decision';
      updateCol = 'final_decision';
    }

    // Record the approval
    await pool.query(
      `INSERT INTO deal_approvals (deal_id, approval_stage, decision, comments, decided_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [deal.id, approvalStage, decision, comments || null, req.user.userId]
    );

    // Update the deal's recommendation field
    if (updateCol) {
      await pool.query(`UPDATE deal_submissions SET ${updateCol} = $1, updated_at = NOW() WHERE id = $2`, [decision, deal.id]);
    }

    await logAudit(deal.id, `recommendation_${approvalStage}`, null, decision,
      { decision, comments, decided_by: req.user.userId, role: req.user.role }, req.user.userId);

    res.json({ success: true, message: `${approvalStage} recorded: ${decision}` });
  } catch (error) {
    console.error('[recommendation] Error:', error);
    res.status(500).json({ error: 'Failed to record recommendation' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN: ASSIGN CREDIT ANALYST / COMPLIANCE TO DEAL
// ═══════════════════════════════════════════════════════════════════════════
app.put('/api/admin/deals/:submissionId/assign-reviewer', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { credit_id, compliance_id } = req.body;

    const dealResult = await pool.query(
      `SELECT id, assigned_credit, assigned_compliance FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    if (credit_id) {
      const creditCheck = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE id = $1', [credit_id]);
      if (creditCheck.rows.length === 0) return res.status(404).json({ error: 'Credit analyst not found' });
      if (!['credit', 'admin'].includes(creditCheck.rows[0].role)) {
        return res.status(400).json({ error: 'User must have credit or admin role' });
      }
      await pool.query(`UPDATE deal_submissions SET assigned_credit = $1, updated_at = NOW() WHERE id = $2`, [credit_id, deal.id]);
      await logAudit(deal.id, 'assigned_credit_analyst', deal.assigned_credit ? String(deal.assigned_credit) : null, String(credit_id),
        { name: `${creditCheck.rows[0].first_name} ${creditCheck.rows[0].last_name}` }, req.user.userId);
    }

    if (compliance_id) {
      const compCheck = await pool.query('SELECT id, role, first_name, last_name FROM users WHERE id = $1', [compliance_id]);
      if (compCheck.rows.length === 0) return res.status(404).json({ error: 'Compliance officer not found' });
      if (!['compliance', 'admin'].includes(compCheck.rows[0].role)) {
        return res.status(400).json({ error: 'User must have compliance or admin role' });
      }
      await pool.query(`UPDATE deal_submissions SET assigned_compliance = $1, updated_at = NOW() WHERE id = $2`, [compliance_id, deal.id]);
      await logAudit(deal.id, 'assigned_compliance', deal.assigned_compliance ? String(deal.assigned_compliance) : null, String(compliance_id),
        { name: `${compCheck.rows[0].first_name} ${compCheck.rows[0].last_name}` }, req.user.userId);
    }

    res.json({ success: true, message: 'Reviewers assigned' });
  } catch (error) {
    console.error('[assign-reviewer] Error:', error);
    res.status(500).json({ error: 'Failed to assign reviewers' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET DEAL AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/deals/:submissionId/audit', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const auditResult = await pool.query(
      `SELECT a.id, a.action, a.from_value, a.to_value, a.details, a.created_at,
              u.first_name, u.last_name, u.role
       FROM deal_audit_log a
       LEFT JOIN users u ON a.performed_by = u.id
       WHERE a.deal_id = $1
       ORDER BY a.created_at DESC`,
      [dealResult.rows[0].id]
    );

    res.json({ success: true, audit: auditResult.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET DEAL FEE PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/deals/:submissionId/fees', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const feesResult = await pool.query(
      `SELECT f.id, f.fee_type, f.amount, f.payment_date, f.payment_ref, f.notes, f.created_at,
              u.first_name, u.last_name
       FROM deal_fee_payments f
       LEFT JOIN users u ON f.confirmed_by = u.id
       WHERE f.deal_id = $1
       ORDER BY f.created_at DESC`,
      [dealResult.rows[0].id]
    );

    res.json({ success: true, fees: feesResult.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch fees' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  INTERNAL STAFF: GET MY ASSIGNED DEALS
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/staff/deals', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const userId = req.user.userId;
    const role = req.user.role;

    let whereClause = '';
    if (role === 'rm') whereClause = `WHERE ds.assigned_rm = $1`;
    else if (role === 'credit') whereClause = `WHERE ds.assigned_credit = $1`;
    else if (role === 'compliance') whereClause = `WHERE ds.assigned_compliance = $1`;
    else if (role === 'admin') whereClause = `WHERE 1=1`; // admin sees all

    const result = await pool.query(
      `SELECT ds.id, ds.submission_id, ds.status, ds.deal_stage, ds.borrower_name, ds.broker_name,
              ds.loan_amount, ds.security_address, ds.asset_type, ds.created_at, ds.updated_at,
              ds.assigned_rm, ds.assigned_credit, ds.assigned_compliance,
              ds.dip_fee_confirmed, ds.commitment_fee_received,
              ds.rm_recommendation, ds.credit_recommendation, ds.compliance_recommendation, ds.final_decision,
              rm.first_name as rm_first, rm.last_name as rm_last,
              cr.first_name as credit_first, cr.last_name as credit_last,
              co.first_name as comp_first, co.last_name as comp_last
       FROM deal_submissions ds
       LEFT JOIN users rm ON ds.assigned_rm = rm.id
       LEFT JOIN users cr ON ds.assigned_credit = cr.id
       LEFT JOIN users co ON ds.assigned_compliance = co.id
       ${whereClause}
       ORDER BY ds.updated_at DESC`,
      role === 'admin' ? [] : [userId]
    );

    res.json({ success: true, deals: result.rows });
  } catch (error) {
    console.error('[staff-deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  BROKER ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════

// Broker: get/create their onboarding record
app.get('/api/broker/onboarding', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'broker') return res.status(403).json({ error: 'Broker access only' });
    let result = await pool.query(`SELECT * FROM broker_onboarding WHERE user_id = $1`, [req.user.userId]);
    if (result.rows.length === 0) {
      result = await pool.query(
        `INSERT INTO broker_onboarding (user_id) VALUES ($1) RETURNING *`, [req.user.userId]
      );
    }
    // Get associated documents
    const docs = await pool.query(
      `SELECT id, filename, file_type, file_size, onedrive_download_url, uploaded_at FROM deal_documents
       WHERE deal_id IS NULL AND id IN (
         SELECT unnest(ARRAY[passport_doc_id, proof_of_address_doc_id, incorporation_doc_id])
         FROM broker_onboarding WHERE user_id = $1
       )`, [req.user.userId]
    );
    res.json({ success: true, onboarding: result.rows[0], documents: docs.rows });
  } catch (error) {
    console.error('[broker-onb] Error:', error);
    res.status(500).json({ error: 'Failed to fetch onboarding data' });
  }
});

// Broker: update their onboarding data
app.put('/api/broker/onboarding', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'broker') return res.status(403).json({ error: 'Broker access only' });
    const {
      individual_name, date_of_birth, is_company, company_name, company_number,
      bank_name, bank_sort_code, bank_account_no, bank_account_name, notes
    } = req.body;

    const result = await pool.query(
      `UPDATE broker_onboarding SET
        individual_name = COALESCE($1, individual_name),
        date_of_birth = COALESCE($2, date_of_birth),
        is_company = COALESCE($3, is_company),
        company_name = COALESCE($4, company_name),
        company_number = COALESCE($5, company_number),
        bank_name = COALESCE($6, bank_name),
        bank_sort_code = COALESCE($7, bank_sort_code),
        bank_account_no = COALESCE($8, bank_account_no),
        bank_account_name = COALESCE($9, bank_account_name),
        notes = COALESCE($10, notes),
        status = CASE WHEN status = 'pending' THEN 'submitted' ELSE status END,
        updated_at = NOW()
       WHERE user_id = $11 RETURNING *`,
      [individual_name, date_of_birth, is_company, company_name, company_number,
       bank_name, bank_sort_code, bank_account_no, bank_account_name, notes, req.user.userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Onboarding record not found' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    console.error('[broker-onb] Update error:', error);
    res.status(500).json({ error: 'Failed to update onboarding data' });
  }
});

// Admin: review broker onboarding
app.put('/api/admin/broker/:userId/onboarding', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!['approved', 'rejected', 'under_review'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const result = await pool.query(
      `UPDATE broker_onboarding SET status = $1, notes = COALESCE($2, notes),
       reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE user_id = $4 RETURNING *`,
      [status, notes, req.user.userId, req.params.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Broker onboarding not found' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update broker onboarding' });
  }
});

// Admin: get broker onboarding status
app.get('/api/admin/broker/:userId/onboarding', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM broker_onboarding WHERE user_id = $1`, [req.params.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No onboarding record' });
    res.json({ success: true, onboarding: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch broker onboarding' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LAW FIRMS (manage legal firms)
// ═══════════════════════════════════════════════════════════════════════════

// List law firms
app.get('/api/law-firms', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM law_firms WHERE is_active = TRUE ORDER BY firm_name`);
    res.json({ success: true, law_firms: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch law firms' });
  }
});

// Create law firm
app.post('/api/law-firms', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { firm_name, contact_name, email, phone, address, notes } = req.body;
    if (!firm_name) return res.status(400).json({ error: 'Firm name is required' });

    const result = await pool.query(
      `INSERT INTO law_firms (firm_name, contact_name, email, phone, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [firm_name, contact_name || null, email || null, phone || null, address || null, notes || null]
    );
    res.status(201).json({ success: true, law_firm: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create law firm' });
  }
});

// Update law firm
app.put('/api/law-firms/:id', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { firm_name, contact_name, email, phone, address, notes, is_active } = req.body;

    const result = await pool.query(
      `UPDATE law_firms SET
        firm_name = COALESCE($1, firm_name),
        contact_name = COALESCE($2, contact_name),
        email = COALESCE($3, email),
        phone = COALESCE($4, phone),
        address = COALESCE($5, address),
        notes = COALESCE($6, notes),
        is_active = COALESCE($7, is_active),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [firm_name || null, contact_name || null, email || null, phone || null, address || null, notes || null,
       is_active !== undefined ? is_active : null, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Law firm not found' });
    res.json({ success: true, law_firm: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update law firm' });
  }
});

// Delete (deactivate) law firm
app.delete('/api/law-firms/:id', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE law_firms SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING firm_name`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Law firm not found' });
    res.json({ success: true, message: `Law firm ${result.rows[0].firm_name} deactivated` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to deactivate law firm' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEAL LIFECYCLE ENDPOINTS (issue-dip, generate-ai-termsheet, etc.)
// ═══════════════════════════════════════════════════════════════════════════

// Issue DIP (Detailed Information Package)
app.post('/api/deals/:submissionId/issue-dip', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { notes, dip_data } = req.body;

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    // Build update: store DIP data in ai_termsheet_data, update key deal fields, and dip_notes
    const updateFields = [];
    const updateValues = [req.user.userId, notes || null, dealId];
    let paramIdx = 4;

    // Store structured DIP data
    if (dip_data) {
      updateFields.push(`ai_termsheet_data = $${paramIdx}`);
      updateValues.splice(2, 0, JSON.stringify(dip_data));
      paramIdx++;

      // Also update core deal fields from DIP data
      if (dip_data.loan_amount !== undefined) {
        updateFields.push(`loan_amount = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.loan_amount);
        paramIdx++;
      }
      if (dip_data.ltv !== undefined) {
        updateFields.push(`ltv_requested = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.ltv);
        paramIdx++;
      }
      if (dip_data.term_months !== undefined) {
        updateFields.push(`term_months = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.term_months);
        paramIdx++;
      }
      if (dip_data.rate_monthly !== undefined) {
        updateFields.push(`rate_requested = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.rate_monthly);
        paramIdx++;
      }
      if (dip_data.property_value !== undefined) {
        updateFields.push(`current_value = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.property_value);
        paramIdx++;
      }
      if (dip_data.exit_strategy !== undefined) {
        updateFields.push(`exit_strategy = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.exit_strategy);
        paramIdx++;
      }
      if (dip_data.interest_servicing !== undefined) {
        updateFields.push(`interest_servicing = $${paramIdx}`);
        updateValues.splice(2, 0, dip_data.interest_servicing);
        paramIdx++;
      }
    }

    updateFields.push(`status = 'dip_issued'`);
    updateFields.push(`deal_stage = 'dip_issued'`);
    updateFields.push(`dip_issued_at = NOW()`);
    updateFields.push(`dip_issued_by = $1`);
    updateFields.push(`dip_notes = $2`);
    updateFields.push(`updated_at = NOW()`);

    const result = await pool.query(
      `UPDATE deal_submissions SET ${updateFields.join(', ')} WHERE id = $${paramIdx} RETURNING submission_id, status, dip_issued_at`,
      updateValues
    );

    await logAudit(dealId, 'dip_issued', dealResult.rows[0].status, 'dip_issued',
      { issued_by: req.user.userId, dip_data_stored: !!dip_data }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    console.error('[issue-dip] Error:', error);
    res.status(500).json({ error: 'Failed to issue DIP' });
  }
});

// Generate AI Termsheet
app.post('/api/deals/:submissionId/generate-ai-termsheet', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { ai_termsheet_data } = req.body;

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'ai_termsheet',
        ai_termsheet_data = $1,
        ai_termsheet_generated_at = NOW(),
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, ai_termsheet_generated_at`,
      [ai_termsheet_data ? JSON.stringify(ai_termsheet_data) : '{}', dealId]
    );

    await logAudit(dealId, 'ai_termsheet_generated', dealResult.rows[0].status, 'ai_termsheet',
      { generated_by: req.user.userId }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate termsheet' });
  }
});

// Credit analyst decision on DIP
app.post('/api/deals/:submissionId/credit-decision', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { decision, notes, conditions, next_stage } = req.body;
    if (!decision) return res.status(400).json({ error: 'Decision is required' });

    const dealResult = await pool.query(
      `SELECT id, status, ai_termsheet_data FROM deal_submissions WHERE submission_id = $1`,
      [req.params.submissionId]
    );
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    // Store credit decision in ai_termsheet_data
    const existingData = deal.ai_termsheet_data || {};
    existingData.credit_decision = {
      decision,
      notes,
      conditions,
      decided_by: req.user.userId,
      decided_at: new Date().toISOString()
    };

    const updates = [
      'ai_termsheet_data = $1',
      'credit_recommendation = $2',
      'updated_at = NOW()'
    ];
    const values = [JSON.stringify(existingData), decision];
    let paramIdx = 3;

    // Set the next stage based on decision
    if (decision === 'approve') {
      updates.push(`status = $${paramIdx}`);
      values.push('info_gathering');
      paramIdx++;
    } else if (decision === 'decline') {
      updates.push(`status = $${paramIdx}`);
      values.push('declined');
      paramIdx++;
    } else if (decision === 'moreinfo') {
      updates.push(`status = $${paramIdx}`);
      values.push('assigned');
      paramIdx++;
    }

    values.push(req.params.submissionId);
    await pool.query(
      `UPDATE deal_submissions SET ${updates.join(', ')} WHERE submission_id = $${paramIdx}`,
      values
    );

    await logAudit(deal.id, 'credit_decision', deal.status, decision === 'approve' ? 'info_gathering' : decision === 'decline' ? 'declined' : 'assigned',
      { decision, notes: notes.substring(0, 200), conditions: conditions.substring(0, 200) }, req.user.userId);

    res.json({ success: true, message: `Credit decision: ${decision}` });
  } catch (error) {
    console.error('[credit-decision] Error:', error);
    res.status(500).json({ error: 'Failed to record credit decision' });
  }
});

// Request Fee
app.post('/api/deals/:submissionId/request-fee', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { fee_requested_amount } = req.body;
    if (!fee_requested_amount) return res.status(400).json({ error: 'Fee amount is required' });

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'fee_pending',
        fee_requested_at = NOW(),
        fee_requested_amount = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, fee_requested_at, fee_requested_amount`,
      [fee_requested_amount, dealId]
    );

    await logAudit(dealId, 'fee_requested', dealResult.rows[0].status, 'fee_pending',
      { amount: fee_requested_amount }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to request fee' });
  }
});

// Bank Submit
app.post('/api/deals/:submissionId/bank-submit', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { bank_reference } = req.body;

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'bank_submitted',
        bank_submitted_at = NOW(),
        bank_submitted_by = $1,
        bank_reference = $2,
        updated_at = NOW()
       WHERE id = $3 RETURNING submission_id, status, bank_submitted_at, bank_reference`,
      [req.user.userId, bank_reference || null, dealId]
    );

    await logAudit(dealId, 'bank_submitted', dealResult.rows[0].status, 'bank_submitted',
      { bank_reference }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit to bank' });
  }
});

// Bank Approve
app.post('/api/deals/:submissionId/bank-approve', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { bank_approval_notes } = req.body;

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'bank_approved',
        bank_approved_at = NOW(),
        bank_approval_notes = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, bank_approved_at`,
      [bank_approval_notes || null, dealId]
    );

    await logAudit(dealId, 'bank_approved', dealResult.rows[0].status, 'bank_approved',
      { notes: bank_approval_notes }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve deal at bank' });
  }
});

// Borrower Accept
app.post('/api/deals/:submissionId/borrower-accept', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id, status, borrower_user_id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const dealId = dealResult.rows[0].id;
    // Only the assigned borrower can accept
    if (dealResult.rows[0].borrower_user_id && dealResult.rows[0].borrower_user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to accept this deal' });
    }

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'borrower_accepted',
        borrower_accepted_at = NOW(),
        borrower_user_id = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, status, borrower_accepted_at`,
      [req.user.userId, dealId]
    );

    await logAudit(dealId, 'borrower_accepted', dealResult.rows[0].status, 'borrower_accepted',
      { accepted_by: req.user.userId }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to accept deal' });
  }
});

// Instruct Legal
app.post('/api/deals/:submissionId/instruct-legal', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { lawyer_firm, lawyer_email, lawyer_contact, lawyer_reference } = req.body;
    if (!lawyer_firm) return res.status(400).json({ error: 'Law firm is required' });

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        status = 'legal_instructed',
        legal_instructed_at = NOW(),
        lawyer_firm = $1,
        lawyer_email = $2,
        lawyer_contact = $3,
        lawyer_reference = $4,
        updated_at = NOW()
       WHERE id = $5 RETURNING submission_id, status, legal_instructed_at, lawyer_firm`,
      [lawyer_firm, lawyer_email || null, lawyer_contact || null, lawyer_reference || null, dealId]
    );

    await logAudit(dealId, 'legal_instructed', dealResult.rows[0].status, 'legal_instructed',
      { lawyer_firm, lawyer_email }, req.user.userId);

    res.json({ success: true, deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to instruct legal' });
  }
});

// Invite Borrower
app.post('/api/deals/:submissionId/invite-borrower', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { borrower_invite_email } = req.body;
    if (!borrower_invite_email) return res.status(400).json({ error: 'Borrower email is required' });

    const dealResult = await pool.query(`SELECT id, status FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const dealId = dealResult.rows[0].id;

    const result = await pool.query(
      `UPDATE deal_submissions SET
        borrower_invited_at = NOW(),
        borrower_invite_email = $1,
        updated_at = NOW()
       WHERE id = $2 RETURNING submission_id, borrower_invited_at, borrower_invite_email`,
      [borrower_invite_email, dealId]
    );

    // Send invitation email
    try {
      await sendEmailViaGraph({
        to: borrower_invite_email,
        subject: 'Daksfirst Loan Application - Portal Access',
        htmlBody: `<p>You have been invited to review your loan application on the Daksfirst portal.</p>
          <p><a href="https://apply.daksfirst.com/deals/${req.params.submissionId}">View Your Application</a></p>`
      });
    } catch (emailErr) {
      console.error('[invite-borrower] Email failed:', emailErr.message);
      // Continue anyway - email failure shouldn't block the invitation
    }

    await logAudit(dealId, 'borrower_invited', dealResult.rows[0].status, 'borrower_invited',
      { email: borrower_invite_email }, req.user.userId);

    res.json({ success: true, deal: result.rows[0], message: 'Invitation sent' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to invite borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEAL BORROWERS (multiple borrowers per deal)
// ═══════════════════════════════════════════════════════════════════════════

// Add borrower to deal
app.post('/api/deals/:submissionId/borrowers', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number } = req.body;
    if (!full_name) return res.status(400).json({ error: 'Full name is required' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `INSERT INTO deal_borrowers (deal_id, role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [dealResult.rows[0].id, role || 'primary', full_name, date_of_birth || null, nationality || null,
       jurisdiction || null, email || null, phone || null, address || null, borrower_type || 'individual',
       company_name || null, company_number || null]
    );

    await logAudit(dealResult.rows[0].id, 'borrower_added', null, full_name,
      { role: role || 'primary', borrower_type: borrower_type || 'individual' }, req.user.userId);

    res.status(201).json({ success: true, borrower: result.rows[0] });
  } catch (error) {
    console.error('[borrower] Error:', error);
    res.status(500).json({ error: 'Failed to add borrower' });
  }
});

// Get borrowers for a deal
app.get('/api/deals/:submissionId/borrowers', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(
      `SELECT * FROM deal_borrowers WHERE deal_id = $1 ORDER BY role = 'primary' DESC, created_at`,
      [dealResult.rows[0].id]
    );
    res.json({ success: true, borrowers: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch borrowers' });
  }
});

// Update borrower
app.put('/api/deals/:submissionId/borrowers/:borrowerId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address, borrower_type, company_name, company_number, kyc_status, kyc_data } = req.body;

    const result = await pool.query(
      `UPDATE deal_borrowers SET
        role = COALESCE($1, role), full_name = COALESCE($2, full_name),
        date_of_birth = COALESCE($3, date_of_birth), nationality = COALESCE($4, nationality),
        jurisdiction = COALESCE($5, jurisdiction), email = COALESCE($6, email),
        phone = COALESCE($7, phone), address = COALESCE($8, address),
        borrower_type = COALESCE($9, borrower_type), company_name = COALESCE($10, company_name),
        company_number = COALESCE($11, company_number), kyc_status = COALESCE($12, kyc_status),
        kyc_data = COALESCE($13, kyc_data), updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [role, full_name, date_of_birth, nationality, jurisdiction, email, phone, address,
       borrower_type, company_name, company_number, kyc_status, kyc_data ? JSON.stringify(kyc_data) : null,
       req.params.borrowerId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Borrower not found' });
    res.json({ success: true, borrower: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update borrower' });
  }
});

// Delete borrower
app.delete('/api/deals/:submissionId/borrowers/:borrowerId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM deal_borrowers WHERE id = $1 RETURNING full_name`, [req.params.borrowerId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Borrower not found' });
    res.json({ success: true, message: `Borrower ${result.rows[0].full_name} removed` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove borrower' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEAL PROPERTIES (portfolio — multiple properties per deal)
// ═══════════════════════════════════════════════════════════════════════════

// Add property to deal
app.post('/api/deals/:submissionId/properties', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
            gdv, reinstatement, title_number, solicitor_firm, solicitor_ref, notes } = req.body;
    if (!address) return res.status(400).json({ error: 'Property address is required' });

    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    // Calculate day 1 LTV if we have market_value and loan_amount
    let day1Ltv = null;
    if (market_value) {
      const loanResult = await pool.query(`SELECT loan_amount FROM deal_submissions WHERE id = $1`, [dealResult.rows[0].id]);
      if (loanResult.rows[0]?.loan_amount) {
        day1Ltv = ((loanResult.rows[0].loan_amount / market_value) * 100).toFixed(2);
      }
    }

    const result = await pool.query(
      `INSERT INTO deal_properties (deal_id, address, postcode, property_type, tenure, occupancy, current_use,
        market_value, purchase_price, gdv, reinstatement, day1_ltv, title_number, solicitor_firm, solicitor_ref, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [dealResult.rows[0].id, address, postcode || null, property_type || null, tenure || null,
       occupancy || null, current_use || null, market_value || null, purchase_price || null,
       gdv || null, reinstatement || null, day1Ltv, title_number || null,
       solicitor_firm || null, solicitor_ref || null, notes || null]
    );

    await logAudit(dealResult.rows[0].id, 'property_added', null, address, { property_type, market_value }, req.user.userId);
    res.status(201).json({ success: true, property: result.rows[0] });
  } catch (error) {
    console.error('[property] Error:', error);
    res.status(500).json({ error: 'Failed to add property' });
  }
});

// Get properties for a deal
app.get('/api/deals/:submissionId/properties', authenticateToken, async (req, res) => {
  try {
    const dealResult = await pool.query(`SELECT id FROM deal_submissions WHERE submission_id = $1`, [req.params.submissionId]);
    if (dealResult.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const result = await pool.query(`SELECT * FROM deal_properties WHERE deal_id = $1 ORDER BY created_at`, [dealResult.rows[0].id]);

    // Portfolio summary
    const summary = {
      total_properties: result.rows.length,
      total_market_value: result.rows.reduce((sum, p) => sum + (parseFloat(p.market_value) || 0), 0),
      total_gdv: result.rows.reduce((sum, p) => sum + (parseFloat(p.gdv) || 0), 0),
      total_purchase_price: result.rows.reduce((sum, p) => sum + (parseFloat(p.purchase_price) || 0), 0)
    };

    res.json({ success: true, properties: result.rows, summary });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// Update property
app.put('/api/deals/:submissionId/properties/:propertyId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const { address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
            gdv, reinstatement, title_number, valuation_date, insurance_sum, solicitor_firm, solicitor_ref, notes } = req.body;

    const result = await pool.query(
      `UPDATE deal_properties SET
        address = COALESCE($1, address), postcode = COALESCE($2, postcode),
        property_type = COALESCE($3, property_type), tenure = COALESCE($4, tenure),
        occupancy = COALESCE($5, occupancy), current_use = COALESCE($6, current_use),
        market_value = COALESCE($7, market_value), purchase_price = COALESCE($8, purchase_price),
        gdv = COALESCE($9, gdv), reinstatement = COALESCE($10, reinstatement),
        title_number = COALESCE($11, title_number), valuation_date = COALESCE($12, valuation_date),
        insurance_sum = COALESCE($13, insurance_sum), solicitor_firm = COALESCE($14, solicitor_firm),
        solicitor_ref = COALESCE($15, solicitor_ref), notes = COALESCE($16, notes), updated_at = NOW()
       WHERE id = $17 RETURNING *`,
      [address, postcode, property_type, tenure, occupancy, current_use, market_value, purchase_price,
       gdv, reinstatement, title_number, valuation_date, insurance_sum, solicitor_firm, solicitor_ref, notes,
       req.params.propertyId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    res.json({ success: true, property: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// Delete property
app.delete('/api/deals/:submissionId/properties/:propertyId', authenticateToken, authenticateInternal, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM deal_properties WHERE id = $1 RETURNING address`, [req.params.propertyId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Property not found' });
    res.json({ success: true, message: `Property removed` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove property' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  WEBHOOK FIRE TO n8n (with retry) - kept for reference, not used in V2
// ═══════════════════════════════════════════════════════════════════════════
async function fireWebhook(dealId, submissionId, dealData, userData) {
  if (!N8N_WEBHOOK_URL) {
    console.log('[webhook] No N8N_WEBHOOK_URL configured — skipping');
    return;
  }

  const payload = {
    submissionId: submissionId,
    source: 'web_form',
    timestamp: new Date().toISOString(),
    submittedBy: {
      userId: userData.userId,
      email: userData.email,
      role: userData.role
    },
    borrower: {
      name: dealData.borrower_name || '',
      company: dealData.borrower_company || '',
      email: dealData.borrower_email || '',
      phone: dealData.borrower_phone || ''
    },
    broker: {
      name: dealData.broker_name || '',
      company: dealData.broker_company || '',
      fca_number: dealData.broker_fca || ''
    },
    security: {
      address: dealData.security_address || '',
      postcode: dealData.security_postcode || '',
      asset_type: dealData.asset_type || '',
      current_value: dealData.current_value || null
    },
    loan: {
      amount: dealData.loan_amount || null,
      ltv_requested: dealData.ltv_requested || null,
      purpose: dealData.loan_purpose || '',
      exit_strategy: dealData.exit_strategy || '',
      term_months: dealData.term_months || null,
      rate_requested: dealData.rate_requested || null
    },
    documents: dealData.documents || [],
    additional_notes: dealData.additional_notes || ''
  };

  const delays = [0, 5000, 15000, 45000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delays[attempt]));

    try {
      console.log(`[webhook] Attempt ${attempt + 1} for deal ${submissionId}`);
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': process.env.WEBHOOK_SECRET || 'daksfirst_webhook_2026'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });

      const responseText = await response.text();

      await pool.query(
        `INSERT INTO webhook_log (deal_id, attempt, status_code, response_body) VALUES ($1,$2,$3,$4)`,
        [dealId, attempt + 1, response.status, responseText.substring(0, 500)]
      );

      if (response.ok) {
        await pool.query(
          `UPDATE deal_submissions SET webhook_status='sent', webhook_attempts=$1, webhook_last_try=NOW(), status='processing' WHERE id=$2`,
          [attempt + 1, dealId]
        );
        console.log(`[webhook] Success for deal ${submissionId} on attempt ${attempt + 1}`);
        return;
      }

      console.warn(`[webhook] Non-OK response ${response.status} for deal ${submissionId}`);
    } catch (err) {
      console.error(`[webhook] Attempt ${attempt + 1} failed for deal ${submissionId}:`, err.message);
      await pool.query(
        `INSERT INTO webhook_log (deal_id, attempt, error_message) VALUES ($1,$2,$3)`,
        [dealId, attempt + 1, err.message]
      ).catch(() => {});
    }
  }

  await pool.query(
    `UPDATE deal_submissions SET webhook_status='failed', webhook_attempts=4, webhook_last_try=NOW() WHERE id=$1`,
    [dealId]
  ).catch(() => {});
  console.error(`[webhook] All retries exhausted for deal ${submissionId}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SMART DOCUMENT DROP: Upload + Parse via n8n/Claude AI
// ═══════════════════════════════════════════════════════════════════════════

// Environment variable for the parsing webhook (separate from main webhook)
const N8N_PARSE_WEBHOOK_URL = process.env.N8N_PARSE_WEBHOOK_URL || '';

// Upload files for AI parsing (new deal or existing deal)
app.post('/api/smart-parse/upload', authenticateToken, upload.any(), async (req, res) => {
  try {
    console.log('[smart-parse] Upload from user:', req.user.userId, 'files:', req.files?.length || 0);
    const { deal_id, whatsapp_text } = req.body; // deal_id is optional (if updating existing deal)

    if ((!req.files || req.files.length === 0) && !whatsapp_text) {
      return res.status(400).json({ error: 'No files or text provided' });
    }

    // If deal_id provided, verify access
    let existingDeal = null;
    if (deal_id) {
      const dealCheck = await pool.query(
        `SELECT id, submission_id, user_id, borrower_user_id FROM deal_submissions WHERE submission_id = $1`,
        [deal_id]
      );
      if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      const d = dealCheck.rows[0];
      // Check access: owner, borrower, or internal staff
      const isOwner = d.user_id === req.user.userId || d.borrower_user_id === req.user.userId;
      const isInternal = INTERNAL_ROLES.includes(req.user.role);
      if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });
      existingDeal = d;
    }

    // Create a parse session to track the request
    const parseSessionId = require('crypto').randomUUID();

    // Upload files to OneDrive under a /Parsing/ folder
    let token;
    const uploadedFiles = [];
    try {
      token = await getGraphToken();
    } catch (err) {
      console.error('[smart-parse] OneDrive token failed:', err.message);
      // Continue without OneDrive - we'll send file buffers directly to n8n
    }

    const fileMetadata = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileMeta = {
          filename: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          // Base64 encode file content for n8n webhook
          content_base64: file.buffer.toString('base64')
        };
        fileMetadata.push(fileMeta);

        // Also upload to OneDrive if token available
        if (token) {
          try {
            const dealRef = existingDeal ? existingDeal.submission_id.substring(0, 8) : parseSessionId.substring(0, 8);
            const info = await uploadFileToOneDrive(token, dealRef, file.originalname, file.buffer);
            uploadedFiles.push({
              filename: file.originalname,
              file_type: file.mimetype,
              file_size: file.size,
              onedrive_item_id: info.itemId,
              onedrive_path: info.path,
              onedrive_download_url: info.downloadUrl
            });
          } catch (err) {
            console.error('[smart-parse] OneDrive upload failed for:', file.originalname);
          }
        }
      }
    }

    // Save file records to deal_documents — always, even without OneDrive
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const matchingUpload = uploadedFiles.find(u => u.filename === file.originalname);
        await pool.query(
          `INSERT INTO deal_documents (deal_id, parse_session_id, filename, file_type, file_size, onedrive_item_id, onedrive_path, onedrive_download_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            existingDeal ? existingDeal.id : null,
            parseSessionId,
            file.originalname,
            file.mimetype,
            file.size,
            matchingUpload ? matchingUpload.onedrive_item_id : null,
            matchingUpload ? matchingUpload.onedrive_path : null,
            matchingUpload ? matchingUpload.onedrive_download_url : null
          ]
        );
      }
      console.log(`[smart-parse] Saved ${req.files.length} file records to deal_documents (parse_session_id: ${parseSessionId})`);
    }

    // Send to n8n parse webhook for AI extraction
    let parsedData = null;
    if (N8N_PARSE_WEBHOOK_URL) {
      try {
        console.log('[smart-parse] Sending to n8n for AI parsing...');
        const payload = {
          parse_session_id: parseSessionId,
          user_id: req.user.userId,
          user_email: req.user.email,
          user_role: req.user.role,
          deal_id: existingDeal ? existingDeal.submission_id : null,
          whatsapp_text: whatsapp_text || null,
          files: fileMetadata.map(f => ({
            filename: f.filename,
            mimetype: f.mimetype,
            size: f.size,
            content_base64: f.content_base64
          })),
          timestamp: new Date().toISOString()
        };

        const parseResp = await fetch(N8N_PARSE_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': process.env.WEBHOOK_SECRET || 'daksfirst_webhook_2026'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120000) // 2 min timeout for AI parsing
        });

        if (parseResp.ok) {
          const n8nResult = await parseResp.json();
          console.log('[smart-parse] AI parsing returned:', JSON.stringify(n8nResult).substring(0, 500));
          // n8n returns { parse_session_id, parsed_data, error, file_count, file_names }
          // We need just the parsed_data object
          parsedData = n8nResult.parsed_data || n8nResult || null;
          if (n8nResult.error) {
            console.error('[smart-parse] AI extraction error:', n8nResult.error);
          }
        } else {
          const errText = await parseResp.text();
          console.error('[smart-parse] n8n returned error:', parseResp.status, errText.substring(0, 200));
        }
      } catch (err) {
        console.error('[smart-parse] n8n webhook failed:', err.message);
      }
    } else {
      console.log('[smart-parse] N8N_PARSE_WEBHOOK_URL not configured — returning files without AI parsing');
    }

    // Return the result
    res.json({
      success: true,
      parse_session_id: parseSessionId,
      files_uploaded: uploadedFiles.length,
      files_received: (req.files || []).length,
      has_whatsapp_text: !!whatsapp_text,
      existing_deal: existingDeal ? existingDeal.submission_id : null,
      parsed_data: parsedData || null, // The AI-extracted structured data
      message: parsedData
        ? 'Files parsed successfully. Please review the extracted data.'
        : 'Files uploaded. AI parsing is not configured — please fill in the deal details manually.'
    });
  } catch (error) {
    console.error('[smart-parse] Error:', error);
    res.status(500).json({ error: 'Failed to process uploaded files' });
  }
});

// Callback from n8n after async parsing (if n8n processes asynchronously)
app.post('/api/smart-parse/callback', async (req, res) => {
  try {
    const { parse_session_id, parsed_data, error } = req.body;
    if (!parse_session_id) return res.status(400).json({ error: 'parse_session_id is required' });

    if (error) {
      console.error('[smart-parse-callback] Parse error for session:', parse_session_id, error);
      return res.json({ success: false, error });
    }

    console.log('[smart-parse-callback] Received parsed data for session:', parse_session_id);
    // Store in a temporary table or cache — for now, log it
    // The frontend polls or the n8n response was synchronous
    res.json({ success: true, message: 'Parsed data received' });
  } catch (error) {
    console.error('[smart-parse-callback] Error:', error);
    res.status(500).json({ error: 'Failed to process callback' });
  }
});

// Quick-create deal from parsed data (broker/borrower confirms and submits)
app.post('/api/smart-parse/confirm', authenticateToken, async (req, res) => {
  try {
    const { parsed_data, deal_id, parse_session_id } = req.body;
    if (!parsed_data) return res.status(400).json({ error: 'Parsed data is required' });

    // Sanitise parsed data — convert string numbers, truncate long strings
    const pd = { ...parsed_data };
    const numericFields = ['current_value', 'purchase_price', 'loan_amount', 'ltv_requested', 'rate_requested', 'term_months', 'refurb_cost'];
    for (const f of numericFields) {
      if (pd[f] !== null && pd[f] !== undefined) {
        const num = parseFloat(String(pd[f]).replace(/[£$,]/g, ''));
        pd[f] = isNaN(num) ? null : num;
      }
    }
    // Remove confidence field (not a DB column)
    delete pd.confidence;

    // Auto-calculate indicative loan amount and LTV if not provided
    // Rule: Max 75% LTV (of current value) or 90% LTC (of purchase price), whichever is LOWER
    const currentVal = pd.current_value ? Number(pd.current_value) : null;
    const purchasePrice = pd.purchase_price ? Number(pd.purchase_price) : null;
    const refurbCost = pd.refurb_cost ? Number(pd.refurb_cost) : 0;

    if (!pd.loan_amount && (currentVal || purchasePrice)) {
      const maxByLtv = currentVal ? currentVal * 0.75 : Infinity;  // 75% of value
      const totalCost = purchasePrice ? purchasePrice + refurbCost : Infinity;
      const maxByLtc = totalCost < Infinity ? totalCost * 0.90 : Infinity; // 90% of total cost
      const indicativeLoan = Math.min(maxByLtv, maxByLtc);
      if (indicativeLoan < Infinity) {
        pd.loan_amount = Math.round(indicativeLoan); // Round to nearest pound
        console.log(`[smart-parse] Auto-calculated indicative loan: £${pd.loan_amount} (75% LTV = £${maxByLtv < Infinity ? Math.round(maxByLtv) : 'N/A'}, 90% LTC = £${maxByLtc < Infinity ? Math.round(maxByLtc) : 'N/A'})`);
      }
    }

    if (!pd.ltv_requested && pd.loan_amount && currentVal && currentVal > 0) {
      pd.ltv_requested = Math.round((Number(pd.loan_amount) / currentVal) * 100 * 100) / 100; // 2 decimal places
      console.log(`[smart-parse] Auto-calculated LTV: ${pd.ltv_requested}%`);
    }

    if (deal_id) {
      // UPDATE existing deal with parsed fields
      const dealCheck = await pool.query(
        `SELECT id, user_id, borrower_user_id FROM deal_submissions WHERE submission_id = $1`,
        [deal_id]
      );
      if (dealCheck.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      const deal = dealCheck.rows[0];
      const isOwner = deal.user_id === req.user.userId || deal.borrower_user_id === req.user.userId;
      const isInternal = INTERNAL_ROLES.includes(req.user.role);
      if (!isOwner && !isInternal) return res.status(403).json({ error: 'Access denied' });

      // Update deal with parsed fields (only non-null values)
      const fields = [];
      const values = [];
      let paramIdx = 1;

      const fieldMap = {
        borrower_name: pd.borrower_name, borrower_company: pd.borrower_company,
        borrower_email: pd.borrower_email, borrower_phone: pd.borrower_phone,
        broker_name: pd.broker_name, broker_company: pd.broker_company, broker_fca: pd.broker_fca,
        security_address: pd.security_address, security_postcode: pd.security_postcode,
        asset_type: pd.asset_type, current_value: pd.current_value,
        loan_amount: pd.loan_amount, ltv_requested: pd.ltv_requested,
        loan_purpose: pd.loan_purpose, exit_strategy: pd.exit_strategy,
        term_months: pd.term_months, rate_requested: pd.rate_requested,
        additional_notes: pd.additional_notes,
        borrower_nationality: pd.borrower_nationality, borrower_type: pd.borrower_type,
        company_name: pd.company_name, company_number: pd.company_number,
        interest_servicing: pd.interest_servicing, existing_charges: pd.existing_charges,
        property_tenure: pd.property_tenure, occupancy_status: pd.occupancy_status,
        current_use: pd.current_use, purchase_price: pd.purchase_price,
        use_of_funds: pd.use_of_funds, refurb_scope: pd.refurb_scope,
        refurb_cost: pd.refurb_cost, deposit_source: pd.deposit_source
      };

      for (const [col, val] of Object.entries(fieldMap)) {
        if (val !== undefined && val !== null && val !== '') {
          fields.push(`${col} = $${paramIdx}`);
          values.push(val);
          paramIdx++;
        }
      }

      if (fields.length > 0) {
        fields.push('updated_at = NOW()');
        values.push(deal_id);
        await pool.query(
          `UPDATE deal_submissions SET ${fields.join(', ')} WHERE submission_id = $${paramIdx}`,
          values
        );
      }

      await logAudit(deal.id, 'smart_parse_update', null, 'data_updated',
        { parse_session_id, fields_updated: Object.keys(fieldMap).filter(k => fieldMap[k]) }, req.user.userId);

      res.json({ success: true, message: 'Deal updated with parsed data', submission_id: deal_id });
    } else {
      // CREATE new deal from parsed data
      const result = await pool.query(`
        INSERT INTO deal_submissions (
          user_id, borrower_name, borrower_company, borrower_email, borrower_phone,
          broker_name, broker_company, broker_fca,
          security_address, security_postcode, asset_type, current_value,
          loan_amount, ltv_requested, loan_purpose, exit_strategy,
          term_months, rate_requested, additional_notes, source, internal_status,
          borrower_nationality, borrower_type, company_name, company_number,
          interest_servicing, existing_charges, property_tenure, occupancy_status,
          current_use, purchase_price, use_of_funds, refurb_scope, refurb_cost,
          deposit_source
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
        RETURNING id, submission_id, status, created_at
      `, [
        req.user.userId,
        pd.borrower_name || null, pd.borrower_company || null, pd.borrower_email || null, pd.borrower_phone || null,
        pd.broker_name || null, pd.broker_company || null, pd.broker_fca || null,
        pd.security_address || null, pd.security_postcode || null, pd.asset_type || null, pd.current_value || null,
        pd.loan_amount || null, pd.ltv_requested || null, pd.loan_purpose || null, pd.exit_strategy || null,
        pd.term_months || null, pd.rate_requested || null, pd.additional_notes || null, 'smart_parse', 'new',
        pd.borrower_nationality || null, pd.borrower_type || null, pd.company_name || null, pd.company_number || null,
        pd.interest_servicing || null, pd.existing_charges || null, pd.property_tenure || null, pd.occupancy_status || null,
        pd.current_use || null, pd.purchase_price || null, pd.use_of_funds || null,
        pd.refurb_scope || null, pd.refurb_cost || null, pd.deposit_source || null
      ]);

      const newDeal = result.rows[0];

      // Auto-assign RM from broker's default_rm if applicable
      if (req.user.role === 'broker') {
        const brokerOnb = await pool.query('SELECT default_rm FROM broker_onboarding WHERE user_id = $1', [req.user.userId]);
        if (brokerOnb.rows.length > 0 && brokerOnb.rows[0].default_rm) {
          await pool.query('UPDATE deal_submissions SET assigned_rm = $1, assigned_to = $1, deal_stage = \'assigned\' WHERE id = $2',
            [brokerOnb.rows[0].default_rm, newDeal.id]);
        }
      }

      // Link any documents from the parse session to the new deal
      if (parse_session_id) {
        const linked = await pool.query(
          `UPDATE deal_documents SET deal_id = $1 WHERE parse_session_id = $2 AND deal_id IS NULL`,
          [newDeal.id, parse_session_id]
        );
        console.log(`[smart-parse-confirm] Linked ${linked.rowCount} documents to new deal ${newDeal.submission_id}`);
      }

      await logAudit(newDeal.id, 'deal_submitted_smart_parse', null, 'received',
        { parse_session_id, source: 'smart_parse' }, req.user.userId);

      res.status(201).json({
        success: true,
        message: 'Deal created from parsed documents',
        deal: { id: newDeal.id, submission_id: newDeal.submission_id, status: newDeal.status, created_at: newDeal.created_at }
      });
    }
  } catch (error) {
    console.error('[smart-parse-confirm] Error:', error);
    res.status(500).json({ error: 'Failed to create/update deal from parsed data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;

// Run migrations then start server
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`[daksfirst-auth] v2.0.0 running on port ${PORT}`);
    console.log(`[daksfirst-auth] CORS: apply.daksfirst.com`);
    console.log(`[daksfirst-auth] Webhook: ${N8N_WEBHOOK_URL || 'NOT CONFIGURED'}`);
    console.log(`[daksfirst-auth] OneDrive: ${AZURE_CLIENT_ID ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  });
});
