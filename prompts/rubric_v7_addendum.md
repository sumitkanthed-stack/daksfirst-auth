## SPRINT XCOLL — Cross-collateral / mixed-purpose deals (added v7, 2026-04-29)

The Risk Packager now ships a `cross_collateral` block in the deal envelope alongside `sources_uses`, plus per-property `loan_purpose` and `existing_charge_balance_pence` fields on `features.properties[]`. Use these to grade deals where Daksfirst takes security across multiple properties with mixed charge positions and loan purposes.

### Per-property fields

```
features.properties[].loan_purpose                   -- 'acquisition' | 'refinance' | 'equity_release' | NULL
features.properties[].security_charge_type           -- 'first_charge' | 'second_charge' | 'third_charge' | 'no_charge'
features.properties[].existing_charge_balance_pence  -- BIGINT, prior-charge balance outstanding (refi or 2nd-charge cases)
features.properties[].existing_charges_note          -- TEXT, RM-typed lender + ERC + restriction notes
```

### Cross-collateral summary block

```
cross_collateral = {
  is_cross_collateralised:           bool,    -- > 1 first-charge OR any 2nd/3rd charge
  properties_count:                  int,
  first_charge_count:                int,
  second_charge_count:               int,
  third_charge_count:                int,
  refinance_count:                   int,
  effective_security_value_pence:    int,     -- sum of MV for 1st-charge props ONLY
  comfort_security_value_pence:      int,     -- sum of (MV − prior balance) for 2nd-charge props
  effective_ltv_pct:                 number,  -- daksfirst_exposure / effective_security_value
  daksfirst_exposure_pence:          int,
  total_existing_redemptions_pence:  int,     -- sum of balances on refinance properties
  auto_redemption_lines:             [...],   -- per-property breakdown
}
```

### Grading rules — POLICY LOCKED 2026-04-29

#### Effective LTV is the canonical LTV

Use `cross_collateral.effective_ltv_pct` as the headline LTV in narrative and grade reasoning. NEVER use a gross LTV that includes 2nd-charge property values — that produces a falsely low number that masks the deal's real exposure.

- `effective_ltv_pct > 75` → hard policy ceiling breach. PD downgrade by ≥1 band; rationale must call this out as the binding constraint.
- `effective_ltv_pct` between 65–75 → stretch zone, grade as elevated PD per existing rubric.
- `effective_ltv_pct ≤ 65` → standard treatment.
- `effective_ltv_pct == NULL` (no 1st-charge security at all) → hard decline. Cite "no senior security on this deal" as the policy block.

#### 2nd-charge security is COMFORT ONLY

Cite `comfort_security_value_pence` separately in narrative as a recovery mitigant under the `collateral_quality` determinant. Specific rules:

- 2nd-charge presence may improve `collateral_quality` reasoning by **at most half a band** (e.g. C → C/B, never C → B).
- 2nd-charge MUST NOT reduce `pd` or `lgd` severity by a full band on its own.
- In the LGD recovery scenario, model 2nd-charge recovery as **£0** — the 1st-charge holder controls disposal timing, surplus rarely material, possessory complexity slows everything.
- In rationale, frame as: "additional 2nd-charge security on [address] (£X equity behind £Y existing 1st) provides marginal recovery flexibility but does not reduce headline LTV exposure".

#### Refinance (1st-charge takeover)

When `loan_purpose = 'refinance'` AND `security_charge_type = 'first_charge'`:

- Daksfirst redeems the existing senior lender at completion. Becomes 1st-charge holder.
- The redemption amount in `auto_redemption_lines` is a Use of Daksfirst's loan (subtract from net advance available for acquisition or fees).
- Cite `existing_charges_note` to flag known issues: ERC charges (one-off cost), restrictions on K1 entry (legal complexity), redemption windows (timing risk).
- If redemption is consensual (existing lender will accept payoff) → no penalty.
- If `existing_charges_note` mentions disputed redemption, restriction blocking redemption, or charge from defaulted lender → hard `transaction_integrity` flag, possible decline.

#### Equity release (2nd charge with cash to borrower)

When `loan_purpose = 'equity_release'` AND `security_charge_type IN ('second_charge', 'third_charge')`:

- Daksfirst lends, takes 2nd charge for "comfort", borrower receives cash to fund acquisition (or other use).
- This is a higher-risk structure — there's no senior security on this property.
- The market value of this property gives ZERO LTV credit (not in `effective_security_value_pence`).
- Treat the 2nd-charge `existing_charge_balance_pence` as fixed prior — Daksfirst's recovery is `max(0, market_value − existing_balance − costs)` in the worst case, with the 1st-charge holder controlling timing.
- If the deal as a whole only works via 2nd-charge equity release on existing collateral (no other 1st-charge security), grade `pd` as elevated and cite reliance on borrower's continued performance with the 1st-charge lender.

#### Logical consistency checks

The Risk Packager pre-validates these, but if you see logically inconsistent combinations slip through, flag them under `transaction_integrity`:

- `loan_purpose = 'refinance'` + `security_charge_type ≠ 'first_charge'` → impossible (refi means we redeem and become senior). Treat as data quality red flag, demand RM clarification.
- `loan_purpose = 'equity_release'` + `security_charge_type = 'first_charge'` → impossible (equity release means we sit behind an existing 1st). Same flag.
- `loan_purpose = NULL` and the deal envelope has multiple properties → IA gap (RM hasn't classified each property's role). Penalise IA on `collateral_quality`.

### Citation format

Mirror the v5/v6 dot-path style:

- `cross_collateral.effective_ltv_pct = 71.1% (£2,250,000 / £3,165,000 — 1st-charge security only)`
- `cross_collateral.comfort_security_value_pence = £525,000 (1 property at 2nd charge — comfort only, NOT in LTV)`
- `properties[1].loan_purpose = 'refinance' · security_charge_type = 'first_charge' · existing_charge_balance_pence = £400,000 · existing_charges_note = "Lloyds 1st, no ERC after Dec 2026"`
- `cross_collateral.is_cross_collateralised = true (3 first-charge + 1 second-charge property)`

### Worked example for reasoning

Deal: £2.25m loan against 4 properties.
- Apt 82 — Acquisition + 1st (MV £925k)
- Rannoch — Refinance + 1st (MV £1.59m, redeeming £400k existing)
- Apt 2 — Equity Release + 2nd (MV £525k, behind £350k existing 1st)
- Flat 53 — Acquisition + 1st (MV £650k)

Effective LTV = £2.25m / (£925k + £1.59m + £650k) = £2.25m / £3.165m = **71.1%** (stretch zone, elevated PD).

Comfort security = £525k − £350k = **£175k** behind existing 1st on Apt 2 (cite under `collateral_quality` as marginal recovery flexibility, not LTV credit).

Net advance available after redemption: £2.25m − £400k = **£1.85m** to fund acquisitions of Apt 82 + Flat 53 + fees.

Rationale should cite the 71.1% effective LTV as the binding LTV (not £2.25m / £3.69m gross which would be 61% and misleading).
