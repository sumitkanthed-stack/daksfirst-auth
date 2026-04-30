/**
 * services/exit-conditions.js — Exit-strategy conditions library
 * ════════════════════════════════════════════════════════════════════════════
 * Maps each exit_route_primary value to the list of CPs (Conditions Precedent)
 * that get auto-seeded at DIP issuance.
 *
 * Design (Sumit 2026-04-30):
 *   - DIP stage: broker picks exit_route_primary from dropdown — no naming
 *     of takeout lender / agent / auctioneer required (borrower won't know yet)
 *   - DIP issuance: this library seeds stage-tagged CPs into
 *     deal_conditions_precedent table with status='open'
 *   - DD stage: RM works through CPs, broker provides evidence, status flips
 *   - Pre-completion: every CP must be 'satisfied', 'waived', or 'overridden'
 *
 * Stages used:
 *   'dd'            — provide evidence during DD (DIP+30/60 typical window)
 *   'pre_completion'— must be in place before drawdown
 *
 * Adding/editing entries here changes seeding for FUTURE DIPs only — existing
 * seeded CPs are not retroactively updated. RM can manually add or edit CPs
 * via the deal_conditions_precedent table directly.
 */

const EXIT_CONDITIONS = {
  sale: [
    { stage: 'dd', text: 'Three estate-agent valuations from independent agencies', evidence_doc_type: 'estate_agent_valuations' },
    { stage: 'dd', text: 'Marketing strategy: target asking price vs OMV justification, agent shortlist', evidence_doc_type: 'marketing_strategy' },
    { stage: 'dd', text: 'Marketing instruction signed with named agent — to be in place by month 3 of facility', evidence_doc_type: 'marketing_instruction' },
    { stage: 'pre_completion', text: 'Signed marketing instruction on file with named sole or multiple agency', evidence_doc_type: 'marketing_instruction_signed' },
  ],
  sale_auction: [
    { stage: 'dd', text: 'Confirmed auctioneer + indicative auction date + reserve price agreed with borrower', evidence_doc_type: 'auction_confirmation' },
    { stage: 'dd', text: 'Auction guide price benchmarked against valuer OMV and recent comparable lots', evidence_doc_type: 'auction_pricing_analysis' },
    { stage: 'pre_completion', text: 'Auction listing live with reserve agreed — listing reference on file', evidence_doc_type: 'auction_listing' },
  ],
  refinance_btl: [
    { stage: 'dd', text: 'Identified takeout BTL lender(s) — at least one named or shortlist of three approached', evidence_doc_type: 'takeout_lender_intent' },
    { stage: 'dd', text: 'ICR (Interest Cover Ratio) calculation on the rental valuation at proposed BTL stress rate', evidence_doc_type: 'icr_calc' },
    { stage: 'dd', text: 'Rental valuation by RICS surveyor (separate from open-market valuation)', evidence_doc_type: 'rental_valuation' },
    { stage: 'pre_completion', text: 'Takeout BTL lender DIP letter or AIP on file', evidence_doc_type: 'takeout_dip_letter' },
  ],
  refinance_commercial: [
    { stage: 'dd', text: 'Indicative term sheet from named commercial lender', evidence_doc_type: 'commercial_term_sheet' },
    { stage: 'dd', text: 'Affordability stack: DSCR, debt yield per commercial-lender criteria', evidence_doc_type: 'affordability_stack' },
    { stage: 'dd', text: 'Latest 2 years filed accounts + management accounts to date for trading borrower', evidence_doc_type: 'borrower_accounts' },
    { stage: 'pre_completion', text: 'Commercial-lender DIP letter or term sheet signed', evidence_doc_type: 'commercial_dip_letter' },
  ],
  refinance_owner_occ: [
    { stage: 'dd', text: 'Identified owner-occupier mortgage lender + AIP indication', evidence_doc_type: 'aip_indication' },
    { stage: 'dd', text: 'Borrower affordability evidence: 3 months payslips/SA302s, 3 months bank statements', evidence_doc_type: 'borrower_affordability' },
    { stage: 'dd', text: 'Confirmation borrower will occupy as primary residence (planning + change-of-use checks if currently let)', evidence_doc_type: 'occupancy_confirmation' },
    { stage: 'pre_completion', text: 'Mortgage offer from owner-occupier lender on file', evidence_doc_type: 'mortgage_offer' },
  ],
  refinance_dev_finance: [
    { stage: 'dd', text: 'Planning consent received (or appeal-decision date), no pending material conditions', evidence_doc_type: 'planning_consent' },
    { stage: 'dd', text: 'QS-validated build programme + cost plan + contingency', evidence_doc_type: 'qs_report' },
    { stage: 'dd', text: 'Identified development finance lender + indicative terms', evidence_doc_type: 'dev_lender_intent' },
    { stage: 'dd', text: 'Confirmed contractor / build team with track record evidence', evidence_doc_type: 'contractor_track_record' },
    { stage: 'pre_completion', text: 'Development finance DIP letter on file + planning conditions discharged', evidence_doc_type: 'dev_dip_and_conditions' },
  ],
  combination: [
    { stage: 'dd', text: 'Free-text combination plan: which property/security disposed, which refinanced, allocated debt mapping', evidence_doc_type: 'combination_plan' },
    { stage: 'dd', text: 'RM to elect supplementary CPs from constituent exit types (sale + refi) — manual add', evidence_doc_type: null },
  ],
};

/**
 * Get the list of CPs for a given exit_type, optionally filtered by stage.
 * Returns [] if exit_type isn't in the library.
 */
function getCPsForExit(exitType, stage = null) {
  if (!exitType) return [];
  const cps = EXIT_CONDITIONS[exitType] || [];
  if (!stage) return cps;
  return cps.filter(cp => cp.stage === stage);
}

/**
 * Seed CPs into deal_conditions_precedent for the given deal + exit_type.
 * Idempotent: if any 'auto_exit_library' CPs already exist on the deal, skips.
 * Caller is expected to pass a pool client (or the pool itself).
 *
 * Returns { seeded: <count>, reason: <'seeded'|'already_seeded'|'no_library_match'|'no_exit_type'> }
 */
async function seedConditionsPrecedentIfNeeded(client, dealId, exitType) {
  if (!exitType) {
    return { seeded: 0, reason: 'no_exit_type' };
  }
  const existing = await client.query(
    `SELECT COUNT(*)::int AS n FROM deal_conditions_precedent
     WHERE deal_id = $1 AND source = 'auto_exit_library'`,
    [dealId]
  );
  if (existing.rows[0].n > 0) {
    console.log(`[cp auto-seed] deal ${dealId} already has ${existing.rows[0].n} auto CPs — skipping re-seed`);
    return { seeded: 0, reason: 'already_seeded' };
  }
  const cps = getCPsForExit(exitType);
  if (cps.length === 0) {
    console.log(`[cp auto-seed] no library entries for exit_type='${exitType}' — skipping`);
    return { seeded: 0, reason: 'no_library_match' };
  }
  let seeded = 0;
  for (const cp of cps) {
    try {
      await client.query(
        `INSERT INTO deal_conditions_precedent
          (deal_id, source, exit_type, stage, text, evidence_doc_type, status, created_at, updated_at)
         VALUES ($1, 'auto_exit_library', $2, $3, $4, $5, 'open', NOW(), NOW())`,
        [dealId, exitType, cp.stage, cp.text, cp.evidence_doc_type || null]
      );
      seeded++;
    } catch (e) {
      console.warn(`[cp auto-seed] insert failed for deal ${dealId} stage=${cp.stage}: ${e.message}`);
    }
  }
  console.log(`[cp auto-seed] deal ${dealId} exit='${exitType}' seeded ${seeded}/${cps.length} CPs`);
  return { seeded, reason: 'seeded' };
}

module.exports = {
  EXIT_CONDITIONS,
  getCPsForExit,
  seedConditionsPrecedentIfNeeded,
};
