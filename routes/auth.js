const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const pool = require('../db/pool');
const config = require('../config');
const { authenticateToken } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { sendDealEmail } = require('../services/email');

// REGISTER
router.post('/register', validate('register'), async (req, res) => {
  try {
    console.log('[register] Attempt:', { email: req.body.email, role: req.body.role });
    const { role, first_name, last_name, email, phone, company, fca_number, loan_purpose, loan_amount, source, password } = req.validated;

    // Check existing
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email address already registered' });
    }

    // Hash password + verification token
    const hashedPassword = await bcrypt.hash(password, 12);
    const verificationToken = jwt.sign({ email: email.toLowerCase() }, config.JWT_SECRET, { expiresIn: '24h' });

    // Insert user
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
      const verificationUrl = `${config.VERIFICATION_URL_BASE}?token=${verificationToken}`;
      await sendDealEmail('verification', {
        email: email,
        first_name: first_name,
        verification_url: verificationUrl
      }, email).catch(() => {
        // Email failure doesn't block registration
      });
    } catch (emailErr) {
      console.error('[register] Email error:', emailErr.message);
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );

    const refreshToken = jwt.sign(
      { userId: newUser.id, email: newUser.email, role: newUser.role },
      config.JWT_SECRET,
      { expiresIn: config.JWT_REFRESH_EXPIRY }
    );

    // Store refresh token in DB
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [newUser.id, refreshToken, expiresAt]
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please check your email to verify your account.',
      token: accessToken,             // backward compat with old frontend
      access_token: accessToken,      // new frontend uses this
      refresh_token: refreshToken,
      user: newUser
    });
  } catch (error) {
    console.error('[register] Error:', error);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

// LOGIN
router.post('/login', validate('login'), async (req, res) => {
  try {
    const { email, password } = req.validated;

    const result = await pool.query(
      'SELECT id, email, first_name, last_name, role, company, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );

    const refreshToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.JWT_SECRET,
      { expiresIn: config.JWT_REFRESH_EXPIRY }
    );

    // Store refresh token in DB
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    res.json({
      success: true,
      token: accessToken,           // backward compat with old frontend
      access_token: accessToken,    // new frontend uses this
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        company: user.company || null
      }
    });
  } catch (error) {
    console.error('[login] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// EMAIL VERIFICATION
router.post('/verify', validate('verify'), async (req, res) => {
  try {
    const { token } = req.validated;

    const decoded = jwt.verify(token, config.JWT_SECRET);
    const result = await pool.query(
      'UPDATE users SET email_verified = true, verification_token = null WHERE email = $1 RETURNING id, email, first_name',
      [decoded.email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    console.error('[verify] Error:', error);
    res.status(400).json({ error: 'Invalid or expired verification token' });
  }
});

// REFRESH TOKEN
router.post('/refresh-token', validate('refreshToken'), async (req, res) => {
  try {
    const { refresh_token } = req.validated;

    // Verify refresh token is valid
    let decoded;
    try {
      decoded = jwt.verify(refresh_token, config.JWT_SECRET);
    } catch (err) {
      return res.status(403).json({ error: 'Invalid or expired refresh token' });
    }

    // Check if refresh token exists in DB
    const tokenResult = await pool.query(
      'SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [refresh_token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(403).json({ error: 'Refresh token not found or expired' });
    }

    // Get user details
    const userResult = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Issue new access token
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRY }
    );

    res.json({
      success: true,
      access_token: accessToken
    });
  } catch (error) {
    console.error('[refresh-token] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
