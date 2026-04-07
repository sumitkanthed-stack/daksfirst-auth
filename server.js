require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
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

// ── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth', authLimiter);

// ── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Email ─────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'daksfirst-secret-change-in-prod';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function sendVerificationEmail(email, name, token) {
  const url = `${process.env.FRONTEND_URL}/verify?token=${token}`;
  await transporter.sendMail({
    from: `"Daksfirst Limited" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Verify your Daksfirst account',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#0d2240;padding:24px;text-align:center">
          <h1 style="color:#fff;font-size:22px;margin:0">Daksfirst Limited</h1>
          <p style="color:#c9a84c;margin:4px 0 0;font-size:12px;letter-spacing:2px">BRIDGING FINANCE · UK</p>
        </div>
        <div style="padding:32px;border:1px solid #ddd;border-top:none">
          <p style="font-size:16px">Hi ${name},</p>
          <p>Thank you for registering with Daksfirst. Please verify your email address to activate your account.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${url}" style="background:#0d2240;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px">Verify Email Address</a>
          </div>
          <p style="font-size:12px;color:#999">This link expires in 24 hours. If you did not register, please ignore this email.</p>
        </div>
        <div style="background:#f5f5f5;padding:16px;text-align:center;font-size:11px;color:#999">
          © 2026 Daksfirst Limited · <a href="mailto:sk@daksfirst.com" style="color:#0d2240">sk@daksfirst.com</a>
        </div>
      </div>
    `
  });
}

async function sendWelcomeEmail(email, name, role) {
  await transporter.sendMail({
    from: `"Daksfirst Limited" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Welcome to Daksfirst — Account Verified',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#0d2240;padding:24px;text-align:center">
          <h1 style="color:#fff;font-size:22px;margin:0">Daksfirst Limited</h1>
          <p style="color:#c9a84c;margin:4px 0 0;font-size:12px;letter-spacing:2px">BRIDGING FINANCE · UK</p>
        </div>
        <div style="padding:32px;border:1px solid #ddd;border-top:none">
          <p style="font-size:16px">Hi ${name},</p>
          <p>Your account is now active. You can log in and ${role === 'broker' ? 'start submitting deals' : 'submit your loan enquiry'} at:</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${process.env.FRONTEND_URL}/login" style="background:#c9a84c;color:#0d2240;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px">Log In to Daksfirst</a>
          </div>
          <p>For any questions contact us at <a href="mailto:sk@daksfirst.com">sk@daksfirst.com</a></p>
        </div>
      </div>
    `
  });
}

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role VARCHAR(20) NOT NULL CHECK (role IN ('broker','borrower','admin')),
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(50),
      password_hash VARCHAR(255) NOT NULL,
      company_name VARCHAR(200),
      fca_number VARCHAR(50),
      -- Borrower specific
      introduced_by_broker VARCHAR(200),
      broker_company VARCHAR(200),
      -- Status
      email_verified BOOLEAN DEFAULT FALSE,
      verification_token VARCHAR(255),
      verification_expires TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_ref VARCHAR(50) UNIQUE NOT NULL,
      submitted_by UUID REFERENCES users(id),
      -- Broker attribution (if borrower submits directly)
      attributed_broker_id UUID REFERENCES users(id),
      attributed_broker_name VARCHAR(200),
      -- Broker info (if submitted by broker)
      broker_name VARCHAR(200),
      broker_company VARCHAR(200),
      broker_email VARCHAR(255),
      broker_phone VARCHAR(50),
      -- Property
      property_address TEXT,
      town VARCHAR(100),
      postcode VARCHAR(20),
      asset_type VARCHAR(100),
      tenure VARCHAR(50),
      property_value NUMERIC(15,2),
      gdv NUMERIC(15,2),
      planning_status VARCHAR(100),
      property_desc TEXT,
      -- Loan
      loan_amount NUMERIC(15,2),
      term_months INTEGER,
      loan_type VARCHAR(100),
      senior_junior VARCHAR(50),
      exit_strategy VARCHAR(100),
      rate_ask NUMERIC(5,3),
      arrangement_fee NUMERIC(5,3),
      broker_fee_pct NUMERIC(5,3),
      loan_purpose VARCHAR(100),
      loan_notes TEXT,
      ltv_day1 VARCHAR(20),
      -- Borrower
      client_type VARCHAR(100),
      borrower_name VARCHAR(200),
      company_number VARCHAR(50),
      director_name VARCHAR(200),
      nationality VARCHAR(100),
      residential_status VARCHAR(100),
      equity_amount NUMERIC(15,2),
      equity_source VARCHAR(100),
      adverse_credit VARCHAR(100),
      borrower_background TEXT,
      other_info TEXT,
      -- Pipeline
      status VARCHAR(50) DEFAULT 'Received' CHECK (status IN ('Received','Under Review','DIP Issued','Further Info Required','Credit Approved','Declined','Withdrawn')),
      status_notes TEXT,
      dip_issued_at TIMESTAMPTZ,
      -- Meta
      source VARCHAR(50) DEFAULT 'portal',
      n8n_triggered BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deal_status_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id UUID REFERENCES deals(id),
      old_status VARCHAR(50),
      new_status VARCHAR(50),
      changed_by UUID REFERENCES users(id),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_deals_submitted_by ON deals(submitted_by);
    CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
  console.log('✅ Database initialised');
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const {
    role, first_name, last_name, email, phone, password,
    company_name, fca_number,
    introduced_by_broker, broker_company
  } = req.body;

  if (!role || !first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['broker', 'borrower'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const verification_token = require('crypto').randomBytes(32).toString('hex');
    const verification_expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = await pool.query(`
      INSERT INTO users (role, first_name, last_name, email, phone, password_hash,
        company_name, fca_number, introduced_by_broker, broker_company,
        verification_token, verification_expires)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, role, first_name, last_name, email
    `, [
      role, first_name, last_name, email.toLowerCase(), phone, password_hash,
      company_name || null, fca_number || null,
      introduced_by_broker || null, broker_company || null,
      verification_token, verification_expires
    ]);

    await sendVerificationEmail(email, first_name, verification_token);

    res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account.',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// GET /api/auth/verify?token=xxx
app.get('/api/auth/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'No token provided' });

  try {
    const result = await pool.query(`
      UPDATE users SET email_verified = TRUE, verification_token = NULL
      WHERE verification_token = $1 AND verification_expires > NOW() AND email_verified = FALSE
      RETURNING id, first_name, email, role
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }

    const user = result.rows[0];
    await sendWelcomeEmail(user.email, user.first_name, user.role);
    res.json({ message: 'Email verified successfully', role: user.role });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox.' });
    }

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        company_name: user.company_name
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, role, first_name, last_name, email, phone, company_name, fca_number, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DEAL ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/deals — submit a deal
app.post('/api/deals', authMiddleware, async (req, res) => {
  const data = req.body;
  const deal_ref = 'DFK-' + Date.now().toString(36).toUpperCase();

  try {
    // If borrower submitting — look up attributed broker from their profile
    let attributed_broker_id = null;
    let attributed_broker_name = null;

    if (req.user.role === 'borrower') {
      const userResult = await pool.query(
        'SELECT introduced_by_broker, broker_company FROM users WHERE id = $1',
        [req.user.id]
      );
      const u = userResult.rows[0];
      if (u?.introduced_by_broker) {
        attributed_broker_name = u.introduced_by_broker + (u.broker_company ? ` (${u.broker_company})` : '');
        // Try to find broker account
        const brokerResult = await pool.query(
          `SELECT id FROM users WHERE role = 'broker' AND (
            LOWER(first_name || ' ' || last_name) = LOWER($1) OR
            LOWER(company_name) = LOWER($2)
          ) LIMIT 1`,
          [u.introduced_by_broker, u.broker_company || '']
        );
        if (brokerResult.rows.length > 0) attributed_broker_id = brokerResult.rows[0].id;
      }
    }

    const result = await pool.query(`
      INSERT INTO deals (
        deal_ref, submitted_by, attributed_broker_id, attributed_broker_name,
        broker_name, broker_company, broker_email, broker_phone,
        property_address, town, postcode, asset_type, tenure,
        property_value, gdv, planning_status, property_desc,
        loan_amount, term_months, loan_type, senior_junior, exit_strategy,
        rate_ask, arrangement_fee, broker_fee_pct, loan_purpose, loan_notes, ltv_day1,
        client_type, borrower_name, company_number, director_name,
        nationality, residential_status, equity_amount, equity_source,
        adverse_credit, borrower_background, other_info, source
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
        $33,$34,$35,$36,$37,$38,$39,$40
      ) RETURNING id, deal_ref, status, created_at
    `, [
      deal_ref, req.user.id, attributed_broker_id, attributed_broker_name,
      data.broker_name, data.broker_company, data.broker_email, data.broker_phone,
      data.property_address, data.town, data.postcode, data.asset_type, data.tenure,
      data.property_value || null, data.gdv || null, data.planning_status, data.property_desc,
      data.loan_amount || null, data.term_months || null, data.loan_type, data.senior_junior, data.exit_strategy,
      data.rate_ask || null, data.arrangement_fee || null, data.broker_fee_pct || null,
      data.loan_purpose, data.loan_notes, data.ltv_day1,
      data.client_type, data.borrower_name, data.company_number, data.director_name,
      data.nationality, data.residential_status,
      data.equity_amount || null, data.equity_source,
      data.adverse_credit, data.borrower_background, data.other_info,
      data.source || 'portal'
    ]);

    const deal = result.rows[0];

    // Fire n8n webhook
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, deal_ref, submitted_by_role: req.user.role })
      }).catch(e => console.error('n8n webhook error:', e));
    }

    // Mark as triggered
    await pool.query('UPDATE deals SET n8n_triggered = TRUE WHERE id = $1', [deal.id]);

    res.status(201).json({ message: 'Deal submitted successfully', deal_ref, deal_id: deal.id });
  } catch (err) {
    console.error('Deal submit error:', err);
    res.status(500).json({ error: 'Failed to submit deal' });
  }
});

// GET /api/deals — get deals for logged in user
app.get('/api/deals', authMiddleware, async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'admin') {
      query = `SELECT d.*, u.first_name || ' ' || u.last_name as submitted_by_name, u.role as submitted_by_role
               FROM deals d LEFT JOIN users u ON d.submitted_by = u.id
               ORDER BY d.created_at DESC`;
      params = [];
    } else {
      query = `SELECT d.*, u.first_name || ' ' || u.last_name as submitted_by_name
               FROM deals d LEFT JOIN users u ON d.submitted_by = u.id
               WHERE d.submitted_by = $1 OR d.attributed_broker_id = $2
               ORDER BY d.created_at DESC`;
      params = [req.user.id, req.user.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get deals error:', err);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// GET /api/deals/:id — single deal
app.get('/api/deals/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, u.first_name || ' ' || u.last_name as submitted_by_name
       FROM deals d LEFT JOIN users u ON d.submitted_by = u.id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = result.rows[0];
    // Non-admin can only see their own deals
    if (req.user.role !== 'admin' &&
        deal.submitted_by !== req.user.id &&
        deal.attributed_broker_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(deal);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deal' });
  }
});

// PATCH /api/deals/:id/status — admin updates deal status
app.patch('/api/deals/:id/status', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { status, notes } = req.body;

  try {
    const current = await pool.query('SELECT status FROM deals WHERE id = $1', [req.params.id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    await pool.query('UPDATE deals SET status = $1, status_notes = $2, updated_at = NOW() WHERE id = $3',
      [status, notes, req.params.id]);

    await pool.query(
      'INSERT INTO deal_status_history (deal_id, old_status, new_status, changed_by, notes) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, current.rows[0].status, status, req.user.id, notes]
    );

    res.json({ message: 'Status updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// GET /api/stats — dashboard stats
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    let whereClause = req.user.role !== 'admin' ? 'WHERE submitted_by = $1' : '';
    let params = req.user.role !== 'admin' ? [req.user.id] : [];

    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'Received') as received,
        COUNT(*) FILTER (WHERE status = 'Under Review') as under_review,
        COUNT(*) FILTER (WHERE status = 'DIP Issued') as dip_issued,
        COUNT(*) FILTER (WHERE status = 'Credit Approved') as approved,
        COUNT(*) FILTER (WHERE status = 'Declined') as declined,
        SUM(loan_amount) as total_loan_value
      FROM deals ${whereClause}
    `, params);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'daksfirst-auth' }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🏦 Daksfirst Auth API running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
