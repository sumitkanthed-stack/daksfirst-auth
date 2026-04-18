/**
 * Property Sync — Daksfirst
 *
 * Claude (via n8n) is the ONLY property parser. No regex, no heuristics.
 * This module only handles storing Claude's parsed output into deal_properties.
 *
 * Flow:
 *  1. Deal submitted → raw address stored in deal_submissions
 *  2. n8n fires → Claude parses properties intelligently
 *  3. n8n callback → syncDealProperties() stores Claude's output in deal_properties
 *  4. Broker confirms in matrix → RM confirms in DIP form
 */

/**
 * syncDealProperties — stores parsed properties into the deal_properties table.
 *
 * Strategy: if deal_properties already has manually-entered rows, DON'T overwrite.
 * Only populate if empty or if force mode (Claude override).
 *
 * @param {object} pool     — pg Pool instance
 * @param {number} dealId   — deal_submissions.id
 * @param {Array}  parsed   — array of { address, postcode, market_value, property_type, tenure, source }
 * @param {object} opts     — { force: false } — set true to overwrite auto-parsed entries
 */
async function syncDealProperties(pool, dealId, parsed, opts = {}) {
  if (!parsed || parsed.length === 0) return { action: 'skip', reason: 'no_properties' };

  // Check if deal_properties already has rows
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM deal_properties WHERE deal_id = $1`,
    [dealId]
  );
  const existingCount = existing.rows[0].cnt;

  if (existingCount > 0 && !opts.force) {
    console.log(`[property-sync] deal ${dealId} already has ${existingCount} properties — skipping`);
    return { action: 'skip', reason: 'existing_properties', count: existingCount };
  }

  // If force mode, clear existing auto-parsed / claude-parsed entries (keep manually entered ones)
  if (existingCount > 0 && opts.force) {
    await pool.query(
      `DELETE FROM deal_properties WHERE deal_id = $1 AND (notes = 'auto_parsed' OR notes = 'claude_parsed')`,
      [dealId]
    );
    console.log(`[property-sync] Cleared auto/claude-parsed properties for deal ${dealId}`);
  }

  // Get loan amount for LTV calculation
  const loanResult = await pool.query(
    `SELECT loan_amount FROM deal_submissions WHERE id = $1`, [dealId]
  );
  const loanAmount = loanResult.rows[0]?.loan_amount || null;

  // Insert each property
  const inserted = [];
  for (const prop of parsed) {
    const day1Ltv = (prop.market_value && loanAmount)
      ? ((loanAmount / prop.market_value) * 100).toFixed(2)
      : null;

    const source = prop.source || 'claude_parsed';

    const result = await pool.query(
      `INSERT INTO deal_properties
       (deal_id, address, postcode, property_type, tenure, market_value, purchase_price, day1_ltv, occupancy, current_use, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, address, postcode, market_value, purchase_price`,
      [dealId, prop.address, prop.postcode, prop.property_type, prop.tenure,
       prop.market_value, prop.purchase_price || null, day1Ltv,
       prop.occupancy_status || null, prop.current_use || null, source]
    );
    inserted.push(result.rows[0]);
  }

  console.log(`[property-sync] Inserted ${inserted.length} properties for deal ${dealId}`);
  return { action: 'inserted', count: inserted.length, properties: inserted };
}

module.exports = { syncDealProperties };
