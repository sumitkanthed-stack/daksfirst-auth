## SPRINT PD-1 — PropertyData rental signals (added v6, 2026-04-29)

Each property in `features.properties[]` may now carry verified PAF address fields and PropertyData rental benchmarks. These are auto-pulled by the RM after address verification and persist on `deal_properties`.

### PAF (Royal Mail) verified address — adds IA confidence

```
features.properties[].paf_uprn                    -- Royal Mail UPRN, 12-digit
features.properties[].paf_udprn                   -- Royal Mail UDPRN, 8-digit
features.properties[].paf_address_jsonb           -- full PAF response (lat/lng, ward, district)
features.properties[].paf_pulled_at               -- timestamp
features.properties[].paf_pull_mode               -- mock | test | live
```

### Determinant impact

- **`compliance_kyc`** — Verified PAF UPRN materially raises IA confidence. When `paf_uprn IS NULL` for a property at underwriting stage, this is a soft IA gap (analyst hasn't verified the address against PAF). Cite presence/absence in rationale.
- **`property_physical`** — Use `paf_address_jsonb.country` and `paf_address_jsonb.administrative_county` to verify England-and-Wales-only constraint. Outside E&W → hard policy decline (cite Daksfirst lending criteria).

### PropertyData rental benchmarks — primary BTL underwriting signal

```
features.properties[].pd_rental_pcm_asking_avg     -- £ per calendar month, market median asking
features.properties[].pd_rental_pcm_asking_min     -- 70pc range low
features.properties[].pd_rental_pcm_asking_max     -- 70pc range high
features.properties[].pd_rental_pcm_achieved_avg   -- estimated achieved (asking × 0.92)
features.properties[].pd_rental_pcm_achieved_min   -- range low
features.properties[].pd_rental_pcm_achieved_max   -- range high
features.properties[].pd_rental_yield_gross_pct    -- gross yield against market_value if set
features.properties[].pd_sample_size               -- count of comparable lettings (last 90 days)
features.properties[].pd_beds_filter               -- bed-count filter applied (or null = all units)
features.properties[].pd_pulled_at                 -- timestamp
```

### Determinant impacts

- **`borrower_alm`** — KEY rental coverage signal. For BTL/refinance deals where rental income services debt:
  - Compare deal-stated rent (`market_rent_pcm` or `chimnie_rental_pcm`) to `pd_rental_pcm_achieved_avg`.
  - Stated > +10% above market median achieved → "premium tenancy" — fair signal but may not be sustainable on re-let. Mention as concentration risk if the borrower's exit depends on retaining the current tenant.
  - Stated within ±10% of market median → at-market rental, no concern.
  - Stated < -10% below market median → BELOW market — likely sitting tenant on legacy rate or below-market deal. Flag risk: re-let won't be at this rate, ICR/DSCR forecast on stated rent overstates coverage. Use `pd_rental_pcm_achieved_avg × 0.95` (5% void allowance) as the stress-test rent for ICR/DSCR.
  - Stated < -20% below market median → significant gap. Demand rationale: is there a rent-protected tenancy (regulated tenancy, AST being held below market)? Material BORROWER_ALM concern; downgrade.

- **`exit_pathway`** — When `exit_route_primary IN ('refinance', 'sale_or_refinance')` for a BTL:
  - Refi exit assumes the property will support a BTL refinance loan based on ICR coverage at MARKET RENT, not stated rent.
  - Compute implied rent-coverage: `pd_rental_pcm_achieved_avg × 12 ÷ exit_target_refi_loan` should comfortably exceed the BTL lender's required ICR (typically 125-145% at stress rate 5.5%).
  - If `pd_rental_yield_gross_pct < 4.5%` AND exit is BTL refi → exit fragile, refi market won't lend at these economics. Downgrade `exit_pathway`.

- **`valuation`** — Cross-check `chimnie_rental_pcm` against `pd_rental_pcm_asking_avg`:
  - Spread > ±20% → AVM and PropertyData disagree materially. Cite both numbers in rationale; surveyor's RICS Red Book lettings advice is canonical.
  - When `pd_sample_size < 10`, treat the PropertyData figure as low-confidence (thin comparable pool). Don't downgrade IA on the property side, but note the data-thinness.

- **`property_physical`** — `pd_rental_yield_gross_pct` as a market-quality indicator:
  - Yield > 7% in Greater London / SE → suspiciously high; either the property has issues (HMO with high turnover, problematic location, leasehold issues) or the market value is depressed. Flag for surveyor commentary.
  - Yield < 3% in Greater London / SE → low-yield prime asset; capital appreciation play. Lower BTL refi viability but typically lower default risk.

### IA signal (Information Availability)

- **PD pulled with sample ≥ 20** at underwriting stage → +ve IA signal.
- **PD pulled with sample < 5** → thin coverage, treat as IA C-D for the rental dimension specifically (other dimensions unaffected).
- **PD never pulled** at underwriting stage → IA gap on rental analysis. Penalise IA on `borrower_alm` and `exit_pathway`. RM should pull before the deal goes to credit.

### Citation format

Mirror the v5 dot-path style:

- `properties[2].pd_rental_pcm_achieved_avg = £2,133 pcm vs stated £3,300 pcm (+54.7% above market — premium tenancy)`
- `properties[0].pd_rental_yield_gross_pct = 6.15% (gross, against market value £575k)`
- `properties[1].pd_sample_size = 47 lettings (90d) — high-confidence comparable pool`
- `properties[3].paf_uprn = 100021245001 (verified Royal Mail UPRN; address provenance high)`
- `properties[2].paf_uprn = NULL (analyst has not verified address against PAF — IA gap)`
