const pool = require('../db/pool');

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

module.exports = { logAudit };
