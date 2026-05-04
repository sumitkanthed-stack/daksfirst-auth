// middleware/rbac.js
//
// Role-Based Access Control middleware factory + permission helpers.
// Layers on top of authenticateToken (middleware/auth.js).
//
// Usage in routes:
//   const { requireRoles, requireAssignedRM } = require('../middleware/rbac');
//   router.get('/foo',  authenticateToken, requireRoles(['admin','credit']), handler);
//   router.get('/deals/:submissionId/full',
//              authenticateToken, requireAssignedRM(), handler);
//
// Designed to coexist with existing authenticateAdmin / authenticateInternal —
// no breaking changes. Migrate routes one at a time in Chunks B onwards.

const pool = require('../db/pool');

// ─────────────────────────────────────────────────────────────────────────
// Role-set constants — single source of truth for who falls in which bucket.
// Mirror config.INTERNAL_ROLES + finer-grained sets used by Chunks B-G.
// ─────────────────────────────────────────────────────────────────────────
const ROLE_SETS = {
  ALL_INTERNAL:        ['admin', 'rm', 'credit', 'compliance'],
  PRICING_READ:        ['admin', 'rm', 'credit'],
  PRICING_WRITE:       ['admin'],
  LLM_CONFIG:          ['admin'],
  RISK_TAXONOMY:       ['admin'],
  KYC_AML_REVIEW:      ['admin', 'rm', 'credit', 'compliance'],
  SANCTIONS_PEP:       ['admin', 'credit', 'compliance'],
  AUDIT_LOG_READ:      ['admin', 'compliance'],
  BROKER_TIER_MGMT:    ['admin'],
  USER_CRUD:           ['admin'],
  PAID_API_PULL:       ['admin', 'rm', 'credit'],            // HMLR, Land Registry
  KYC_PRODUCT_PULL:    ['admin', 'rm', 'credit', 'compliance'], // SmartSearch, Experian, Hunter
  INTERNAL_NOTES:      ['admin', 'rm', 'credit', 'compliance'],
  DEAL_ANY_EDIT:       ['admin', 'credit'],
  DEAL_ASSIGNED_EDIT:  ['admin', 'rm', 'credit']
};

// ─────────────────────────────────────────────────────────────────────────
// requireRoles(allowedRoles)
// Factory returning a middleware that 403s if req.user.role isn't allowed.
// Assumes authenticateToken has run — req.user is populated.
// ─────────────────────────────────────────────────────────────────────────
function requireRoles(allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    throw new Error('requireRoles: must pass a non-empty array of role names');
  }
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required_roles: allowedRoles,
        your_role: req.user.role
      });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────
// requireAssignedRM()
// Guards a deal-detail route. Pulls the deal by :submissionId from the URL
// and 403s an RM unless they're the assigned_rm. Admin and credit pass
// through unconditionally. Broker / borrower / compliance get 403 here —
// their own deal-access paths use different middleware (broker = own deals
// only; compliance = KYC sub-routes only).
//
// Why fetch the deal here (vs in handler)? Single source of truth for the
// gating rule. Handler can re-use the loaded deal via req.deal to skip a
// second query.
// ─────────────────────────────────────────────────────────────────────────
function requireAssignedRM() {
  return async function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const role         = req.user.role;
    const userId       = req.user.userId;
    const submissionId = req.params.submissionId || req.params.dealId || req.params.id;

    // Admin + credit: any deal, no DB lookup needed.
    if (role === 'admin' || role === 'credit') return next();

    // Broker / borrower / compliance hitting an RM-gated route — blanket 403.
    if (role !== 'rm') {
      return res.status(403).json({ error: 'Internal RM access required' });
    }

    // RM: must be the assigned_rm on this deal.
    if (!submissionId) {
      return res.status(400).json({ error: 'Deal identifier missing from route params' });
    }

    try {
      const result = await pool.query(
        `SELECT id, submission_id, assigned_rm, assigned_credit, assigned_compliance
           FROM deal_submissions
          WHERE submission_id = $1
             OR id::text   = $1
          LIMIT 1`,
        [submissionId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Deal not found' });
      }
      const deal = result.rows[0];

      if (deal.assigned_rm !== userId) {
        return res.status(403).json({
          error: 'Deal not assigned to you',
          hint: 'Ask admin to reassign or check your queue for assigned deals'
        });
      }

      // Stash for downstream handlers
      req.deal = deal;
      next();
    } catch (err) {
      console.error('[rbac.requireAssignedRM] DB error:', err.message);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// getPermissionFlags(user)
// Returns a plain object the frontend can spread into its RBAC helper.
// Single source of truth — backend computes once, frontend mirrors. Use in
// /api/auth/me response so the SPA never derives permissions from role
// string alone.
// ─────────────────────────────────────────────────────────────────────────
function getPermissionFlags(user) {
  const role = user && user.role ? user.role : 'broker';
  const isInternal = ROLE_SETS.ALL_INTERNAL.includes(role);

  return {
    role,
    isInternal,
    isAdmin:        role === 'admin',
    isCredit:       role === 'credit',
    isRM:           role === 'rm',
    isCompliance:   role === 'compliance',
    isBroker:       role === 'broker',
    isBorrower:     role === 'borrower',

    // Granular capability flags — frontend renders by reading these,
    // not by checking role strings directly.
    canReadPricingConfig:  ROLE_SETS.PRICING_READ.includes(role),
    canEditPricingConfig:  ROLE_SETS.PRICING_WRITE.includes(role),
    canReadLLMConfig:      ROLE_SETS.LLM_CONFIG.includes(role),
    canEditRiskTaxonomy:   ROLE_SETS.RISK_TAXONOMY.includes(role),
    canSeeRiskGradePill:   isInternal,
    canSeeInternalNotes:   ROLE_SETS.INTERNAL_NOTES.includes(role),
    canPullPaidAPIs:       ROLE_SETS.PAID_API_PULL.includes(role),
    canPullKYCProducts:    ROLE_SETS.KYC_PRODUCT_PULL.includes(role),
    canReviewKYC:          ROLE_SETS.KYC_AML_REVIEW.includes(role),
    canReviewSanctions:    ROLE_SETS.SANCTIONS_PEP.includes(role),
    canReadAuditLog:       ROLE_SETS.AUDIT_LOG_READ.includes(role),
    canManageBrokerTiers:  ROLE_SETS.BROKER_TIER_MGMT.includes(role),
    canCRUDUsers:          ROLE_SETS.USER_CRUD.includes(role),
    canEditAnyDeal:        ROLE_SETS.DEAL_ANY_EDIT.includes(role),
    canEditAssignedDeal:   ROLE_SETS.DEAL_ASSIGNED_EDIT.includes(role)
  };
}

// ─────────────────────────────────────────────────────────────────────────
// attachPermissions middleware
// Optional — drops permission flags onto req.user.permissions for handlers
// that want them in-scope without re-deriving. Mount globally after
// authenticateToken if you want this everywhere (Chunk D will).
// ─────────────────────────────────────────────────────────────────────────
function attachPermissions(req, res, next) {
  if (req.user) req.user.permissions = getPermissionFlags(req.user);
  next();
}

module.exports = {
  requireRoles,
  requireAssignedRM,
  getPermissionFlags,
  attachPermissions,
  ROLE_SETS
};