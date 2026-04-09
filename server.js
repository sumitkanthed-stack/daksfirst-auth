require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const app = express();
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

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Email ──────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ── n8n Webhook URL (set in Render environment variables) ──────────────────
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// ── JWT helper ─────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'daksfirst_default_secret';

// ── Auto-migrate: create tables on startup ────────────────────────────────
async function runMigrations() {
  try {
    console.log('[migrate] Running database migrations...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        role            VARCHAR(20)   NOT NULL CHECK (role IN ('broker', 'borrower')),
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
        webhook_status    VARCHAR(20)   DEFAULT 'pending' CHECK (webhook_status IN ('pending','sent','failed','retrying')),
        webhook_attempts  INT           DEFAULT 0,
        webhook_last_try  TIMESTAMPTZ,
        webhook_response  TEXT,
        source            VARCHAR(50)   DEFAULT 'web_form',
        created_at        TIMESTAMPTZ   DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_status      ON deal_submissions(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_user        ON deal_submissions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_submission   ON deal_submissions(submission_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_webhook      ON deal_submissions(webhook_status);`);

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

    console.log('[migrate] All tables and indexes created successfully');
  } catch (err) {
    console.error('[migrate] Migration failed:', err.message);
    // Don't crash — server can still handle requests for endpoints that don't need DB
  }
}

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
    webhook: N8N_WEBHOOK_URL ? 'configured' : 'not configured'
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
    console.log('[register] Created:', newUser.id, newUser.email);

    // Send verification email (non-blocking)
    try {
      const verificationUrl = `https://apply.daksfirst.com/verify?token=${verificationToken}`;
      await transporter.sendMail({
        from: process.env.SMTP_USER || 'sk@daksfirst.com',
        to: email,
        subject: 'Verify Your Daksfirst Account',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#1a365d;">Welcome to Daksfirst</h2>
            <p>Hello ${first_name},</p>
            <p>Thank you for registering. Please verify your email:</p>
            <p><a href="${verificationUrl}" style="background:#c9a84c;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;display:inline-block;">Verify Email Address</a></p>
            <p>This link expires in 24 hours.</p>
            <hr style="margin:30px 0;">
            <p style="color:#666;font-size:14px;">Daksfirst Limited — Bridging Finance, Built for Professionals</p>
          </div>
        `
      });
      console.log('[register] Verification email sent to:', email);
    } catch (emailErr) {
      console.error('[register] Email failed:', emailErr.message);
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
//  DEAL SUBMISSION  (the main new endpoint)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/deals/submit', authenticateToken, async (req, res) => {
  try {
    console.log('[deal] Submission from user:', req.user.userId);
    const {
      borrower_name, borrower_company, borrower_email, borrower_phone,
      broker_name, broker_company, broker_fca,
      security_address, security_postcode, asset_type, current_value,
      loan_amount, ltv_requested, loan_purpose, exit_strategy,
      term_months, rate_requested, additional_notes, documents
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
        term_months, rate_requested, additional_notes, documents, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING id, submission_id, status, created_at
    `, [
      req.user.userId,
      borrower_name || null, borrower_company || null, borrower_email || null, borrower_phone || null,
      broker_name || null, broker_company || null, broker_fca || null,
      security_address, security_postcode || null, asset_type || null, current_value || null,
      loan_amount, ltv_requested || null, loan_purpose, exit_strategy || null,
      term_months || null, rate_requested || null, additional_notes || null,
      JSON.stringify(documents || []), 'web_form'
    ]);

    const deal = result.rows[0];
    console.log('[deal] Created:', deal.submission_id);

    // Fire webhook to n8n (async, non-blocking)
    fireWebhook(deal.id, deal.submission_id, req.body, req.user);

    res.status(201).json({
      success: true,
      message: 'Deal submitted successfully. Our team will review it shortly.',
      deal: {
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
//  GET USER'S DEALS (for dashboard later)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/deals', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT submission_id, status, borrower_name, security_address, loan_amount,
              loan_purpose, asset_type, created_at, updated_at
       FROM deal_submissions WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ success: true, deals: result.rows });
  } catch (error) {
    console.error('[deals] Error:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  WEBHOOK FIRE TO n8n (with retry)
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

  const delays = [0, 5000, 15000, 45000]; // immediate, 5s, 15s, 45s

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

      // Log attempt
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

  // All retries exhausted
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
  });
});
