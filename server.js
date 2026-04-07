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

// FIXED CORS CONFIGURATION - This allows your portal domain
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
const transporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    cors_origins: ['https://apply.daksfirst.com', 'https://daksfirst-auth.vercel.app']
  });
});

// ── User Registration ───────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('Registration attempt:', { ...req.body, password: '[HIDDEN]' });
    
    const {
      role, first_name, last_name, email, phone, company,
      fca_number, loan_purpose, loan_amount, source, password
    } = req.body;

    // Validation
    if (!role || !first_name || !last_name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email address already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Generate verification token
    const verificationToken = jwt.sign(
      { email: email.toLowerCase() },
      process.env.JWT_SECRET || 'daksfirst_default_secret',
      { expiresIn: '24h' }
    );

    // Insert user (minimal schema, avoiding problematic foreign keys)
    const insertQuery = `
      INSERT INTO users (
        role, first_name, last_name, email, phone,
        company, fca_number, loan_purpose, loan_amount,
        source, password_hash, verification_token,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()
      ) RETURNING id, email, first_name, last_name, role
    `;

    const result = await pool.query(insertQuery, [
      role,
      first_name,
      last_name,
      email.toLowerCase(),
      phone,
      company || null,
      fca_number || null,
      loan_purpose || null,
      loan_amount || null,
      source || 'portal',
      hashedPassword,
      verificationToken
    ]);

    const newUser = result.rows[0];
    console.log('User created successfully:', newUser);

    // Send verification email
    try {
      const verificationUrl = `https://apply.daksfirst.com/verify?token=${verificationToken}`;
      
      const mailOptions = {
        from: process.env.SMTP_USER || 'sk@daksfirst.com',
        to: email,
        subject: 'Verify Your Daksfirst Account',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a365d;">Welcome to Daksfirst</h2>
            <p>Hello ${first_name},</p>
            <p>Thank you for registering with Daksfirst. Please verify your email address by clicking the link below:</p>
            <p>
              <a href="${verificationUrl}" 
                 style="background: #c9a84c; color: white; padding: 12px 24px; 
                        text-decoration: none; border-radius: 8px; display: inline-block;">
                Verify Email Address
              </a>
            </p>
            <p>This link will expire in 24 hours.</p>
            <p>If you didn't create this account, please ignore this email.</p>
            <hr style="margin: 30px 0;">
            <p style="color: #666; font-size: 14px;">
              Daksfirst Limited<br>
              Bridging Finance, Built for Professionals
            </p>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      console.log('Verification email sent to:', email);
    } catch (emailError) {
      console.error('Email send error:', emailError);
      // Don't fail registration if email fails
    }

    // Return success
    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please check your email to verify your account.',
      user: {
        id: newUser.id,
        email: newUser.email,
        first_name: newUser.first_name,
        last_name: newUser.last_name,
        role: newUser.role
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// ── User Login ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Get user from database
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, password_hash, email_verified FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Check password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'daksfirst_default_secret',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Email Verification ───────────────────────────────────────────────────────
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'daksfirst_default_secret');
    const email = decoded.email;

    // Update user as verified
    const result = await pool.query(
      'UPDATE users SET email_verified = true, verification_token = null WHERE email = $1 RETURNING id, email, first_name',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    res.json({
      success: true,
      message: 'Email verified successfully'
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(400).json({ error: 'Invalid or expired verification token' });
  }
});

// ── Error Handling ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Catch-all route
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ CORS enabled for: https://apply.daksfirst.com`);
  console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
});
