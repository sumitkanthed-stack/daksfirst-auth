/**
 * Companies House API Routes
 *
 * GET  /api/companies-house/search?q=company+name     — Search by name/number
 * GET  /api/companies-house/verify/:companyNumber      — Full verification report
 * GET  /api/companies-house/profile/:companyNumber     — Quick profile only
 * GET  /api/companies-house/officers/:companyNumber    — Officers list
 * GET  /api/companies-house/pscs/:companyNumber        — Persons with Significant Control
 * GET  /api/companies-house/charges/:companyNumber     — Registered charges
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const companiesHouse = require('../services/companies-house');
const pool = require('../db/pool');

// All routes require authentication
router.use(authenticateToken);

// ─── Search companies ────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const results = await companiesHouse.searchCompany(q);
    res.json({ success: true, results, count: results.length });
  } catch (error) {
    console.error('[companies-house/search] Error:', error.message);
    res.status(error.message.includes('Rate limited') ? 429 : 500).json({
      error: error.message || 'Failed to search Companies House'
    });
  }
});

// ─── Full verification (the main one — used during deal submission) ──────────
router.get('/verify/:companyNumber', async (req, res) => {
  try {
    const { companyNumber } = req.params;
    if (!companyNumber || companyNumber.trim().length < 2) {
      return res.status(400).json({ error: 'Company number is required' });
    }

    const verification = await companiesHouse.verifyCompany(companyNumber);

    // Store verification result in DB for audit trail
    if (verification.found) {
      try {
        await pool.query(`
          INSERT INTO company_verifications
            (company_number, company_name, company_status, risk_score, risk_flags,
             verification_data, verified_by, verified_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (company_number)
          DO UPDATE SET
            company_name = EXCLUDED.company_name,
            company_status = EXCLUDED.company_status,
            risk_score = EXCLUDED.risk_score,
            risk_flags = EXCLUDED.risk_flags,
            verification_data = EXCLUDED.verification_data,
            verified_by = EXCLUDED.verified_by,
            verified_at = NOW()
        `, [
          verification.company_number,
          verification.company_name,
          verification.company_status,
          verification.risk_score,
          JSON.stringify(verification.risk_flags),
          JSON.stringify(verification),
          req.user.userId
        ]);
      } catch (dbErr) {
        // DB storage failure shouldn't block the response
        console.error('[companies-house/verify] DB store failed:', dbErr.message);
      }
    }

    res.json({ success: true, verification });
  } catch (error) {
    console.error('[companies-house/verify] Error:', error.message);
    res.status(error.message.includes('Rate limited') ? 429 : 500).json({
      error: error.message || 'Failed to verify company'
    });
  }
});

// ─── Quick profile only ──────────────────────────────────────────────────────
router.get('/profile/:companyNumber', async (req, res) => {
  try {
    const profile = await companiesHouse.getCompanyProfile(req.params.companyNumber);
    if (!profile) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json({ success: true, profile });
  } catch (error) {
    console.error('[companies-house/profile] Error:', error.message);
    res.status(error.message.includes('Rate limited') ? 429 : 500).json({
      error: error.message || 'Failed to get company profile'
    });
  }
});

// ─── Officers ────────────────────────────────────────────────────────────────
router.get('/officers/:companyNumber', async (req, res) => {
  try {
    const officers = await companiesHouse.getOfficers(req.params.companyNumber);
    res.json({ success: true, officers, count: officers.length });
  } catch (error) {
    console.error('[companies-house/officers] Error:', error.message);
    res.status(error.message.includes('Rate limited') ? 429 : 500).json({
      error: error.message || 'Failed to get officers'
    });
  }
});

// ─── PSCs (Persons with Significant Control) ─────────────────────────────────
router.get('/pscs/:companyNumber', async (req, res) => {
  try {
    const pscs = await companiesHouse.getPSCs(req.params.companyNumber);
    res.json({ success: true, pscs, count: pscs.length });
  } catch (error) {
    console.error('[companies-house/pscs] Error:', error.message);
    res.status(error.message.includes('Rate limited') ? 429 : 500).json({
      error: error.message || 'Failed to get PSCs'
    });
  }
});

// ─── Charges (mortgages, debentures) ─────────────────────────────────────────
router.get('/charges/:companyNumber', async (req, res) => {
  try {
    const charges = await companiesHouse.getCharges(req.params.companyNumber);
    res.json({ success: true, charges, count: charges.length });
  } catch (error) {
    console.error('[companies-house/charges] Error:', error.message);
    res.status(error.message.includes('Rate limited') ? 429 : 500).json({
      error: error.message || 'Failed to get charges'
    });
  }
});

module.exports = router;
