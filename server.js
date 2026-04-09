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

const dealLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
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

    // Migrate existing users table: update role constraint
    try {
      // First, drop the old constraint
      await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
      // Then add the new one
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('broker', 'borrower', 'admin'));`);
      console.log('[migrate] Updated users table role constraint');
    } catch (err) {
      console.log('[migrate] Could not update users role constraint (may already exist):', err.message);
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
      { col: 'deal_stage', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS deal_stage VARCHAR(30) DEFAULT \'dip\';' },
      { col: 'termsheet_signed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS termsheet_signed_at TIMESTAMPTZ;' },
      { col: 'commitment_fee_received', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS commitment_fee_received BOOLEAN DEFAULT FALSE;' }
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
    if (!['broker', 'borrower', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
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
      'SELECT id, email, first_name, last_name, role, password_hash, email_verified FROM users WHERE email = $1',
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
      user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role }
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
      deposit_source, concurrent_transactions
    } = req.body;

    // Validation
    if (!security_address || !loan_amount || !loan_purpose) {
      return res.status(400).json({ error: 'Security address, loan amount and loan purpose are required' });
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
        deposit_source, concurrent_transactions
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
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
      deposit_source || null, concurrent_transactions || null
    ]);

    const deal = result.rows[0];
    console.log('[deal] Created:', deal.submission_id);

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
    const result = await pool.query(
      `SELECT ds.id, ds.submission_id, ds.status, ds.borrower_name, ds.security_address,
              ds.loan_amount, ds.loan_purpose, ds.asset_type, ds.created_at, ds.updated_at,
              COUNT(dd.id) as document_count
       FROM deal_submissions ds
       LEFT JOIN deal_documents dd ON ds.id = dd.deal_id
       WHERE ds.user_id = $1
       GROUP BY ds.id
       ORDER BY ds.created_at DESC`,
      [req.user.userId]
    );
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
    const dealResult = await pool.query(
      `SELECT * FROM deal_submissions WHERE submission_id = $1 AND user_id = $2`,
      [req.params.submissionId, req.user.userId]
    );

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

    let query = `SELECT ds.id, ds.submission_id, ds.status, ds.borrower_name, ds.loan_amount,
                        ds.asset_type, ds.created_at, ds.assigned_to, ds.internal_status,
                        u.first_name, u.last_name, u.company
                 FROM deal_submissions ds
                 LEFT JOIN users u ON ds.assigned_to = u.id
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
app.get('/api/admin/deals/:submissionId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const dealResult = await pool.query(
      `SELECT ds.*, u.first_name, u.last_name, u.email as submitter_email
       FROM deal_submissions ds
       LEFT JOIN users u ON ds.user_id = u.id
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

    res.json({
      success: true,
      deal: {
        ...deal,
        documents: docsResult.rows,
        analysis: analysisResult.rows[0] || null,
        notes: notesResult.rows
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
    let countQuery = `SELECT COUNT(*) as total FROM users WHERE role IN ('broker', 'borrower')`;
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
//  ADMIN: CREATE ADMIN USER (protected)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/admin/create', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, password } = req.body;

    if (!first_name || !last_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check existing
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email address already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (role, first_name, last_name, email, phone, password_hash, email_verified)
       VALUES ('admin', $1, $2, $3, $4, $5, true)
       RETURNING id, email, first_name, last_name, role`,
      [first_name, last_name, email.toLowerCase(), phone, hashedPassword]
    );

    const newAdmin = result.rows[0];
    console.log('[admin-create] New admin created:', newAdmin.id, newAdmin.email, 'by', req.user.userId);

    res.status(201).json({
      success: true,
      message: 'Admin user created successfully',
      user: newAdmin
    });
  } catch (error) {
    console.error('[admin-create] Error:', error);
    res.status(500).json({ error: 'Failed to create admin user' });
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
