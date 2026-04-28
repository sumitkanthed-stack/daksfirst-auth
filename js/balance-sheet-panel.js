/**
 * js/balance-sheet-panel.js — Sprint 3 #17 (2026-04-28)
 * ============================================================
 * Per-UBO balance sheet panel inside the Borrower Financials matrix
 * row. Renders portfolio properties + other assets/liabilities
 * grouped by individual borrower (UBOs, directors, joint borrowers,
 * guarantors).
 *
 * Sets:
 *   window._buildBalanceSheetSection(deal)   — main entry
 *   window._bsAddPortfolioProperty(borrowerId)
 *   window._bsAddAssetLiab(borrowerId, kind)
 *   window._bsDeletePortfolio(id)
 *   window._bsDeleteAssetLiab(id)
 *   window._bsToggleBorrower(borrowerId)
 *
 * Inline forms (no modal). Add buttons reveal a one-row form;
 * save → POST → refresh list. Edits via direct-on-blur PUT.
 *
 * Per-UBO grouping: the panel auto-discovers all individual
 * borrowers in deal.borrowers (any role) and shows one collapsible
 * group per person.
 * ============================================================
 */

(function () {
  if (window._buildBalanceSheetSection) return;

  function _apiBase() {
    return window.location.hostname.startsWith('apply-staging')
      ? 'https://daksfirst-auth-staging.onrender.com'
      : 'https://daksfirst-auth.onrender.com';
  }

  function _token() {
    return sessionStorage.getItem('daksfirst_token') || '';
  }

  async function _api(path, opts) {
    const headers = Object.assign(
      { 'Authorization': 'Bearer ' + _token() },
      (opts && opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      (opts && opts.headers) || {}
    );
    const r = await fetch(_apiBase() + path, Object.assign({}, opts, { headers }));
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (r.status === 401 || r.status === 403) throw new Error('Auth failed — sign in as admin');
    if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _money(v) {
    if (v == null) return '£—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '£—';
    return '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function _pct(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(0) + '%';
  }

  // ════════════════════════════════════════════════════════════
  // Main render entry
  // ════════════════════════════════════════════════════════════

  // Sprint 4 #21 — Consolidated rollup loader. Populates the
  // #consolidated-bs-host element rendered by deal-matrix.js with
  // a roll-up summary of A/L and I/E across all UBOs on the deal.
  window._loadConsolidatedBalanceSheet = async function (dealId) {
    const host = document.getElementById('consolidated-bs-host');
    if (!host || !dealId) return;
    try {
      const j = await _api('/api/admin/balance-sheet/deal/' + dealId + '/consolidated');
      const d = j.data || {};
      const cb = d.consolidated_balance_sheet || {};
      const cie = d.consolidated_income_expense || {};
      const counts = d.counts || {};
      const netColor = cie.effective_monthly_net >= 0 ? '#34D399' : '#F87171';
      host.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' +
          // BALANCE SHEET side
          '<div style="background:rgba(212,168,83,0.04);border:1px solid rgba(212,168,83,0.25);border-radius:6px;padding:12px;">' +
            '<div style="font-size:11px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">📊 Consolidated Balance Sheet</div>' +
            '<table style="width:100%;font-size:12px;">' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">Property value (effective)</td><td style="text-align:right;color:#F1F5F9;">' + _money(cb.effective_property_value) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">Property mortgages (effective)</td><td style="text-align:right;color:#F87171;">−' + _money(cb.effective_property_mortgage) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06);"><strong>= Property equity (effective)</strong></td><td style="text-align:right;color:#34D399;font-weight:700;border-bottom:1px solid rgba(255,255,255,0.06);">' + _money(cb.effective_property_equity) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">+ Other assets</td><td style="text-align:right;color:#F1F5F9;">' + _money(cb.effective_other_assets) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">− Other liabilities</td><td style="text-align:right;color:#F87171;">−' + _money(cb.effective_other_liabilities) + '</td></tr>' +
              '<tr><td style="color:#4EA1FF;padding:6px 0 3px;border-top:2px solid rgba(78,161,255,0.4);font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:11px;">Consolidated net worth</td><td style="text-align:right;color:#34D399;font-weight:800;font-size:14px;border-top:2px solid rgba(78,161,255,0.4);padding-top:6px;">' + _money(cb.effective_consolidated_net_worth) + '</td></tr>' +
            '</table>' +
            '<div style="margin-top:8px;font-size:10px;color:#64748B;">' + counts.portfolio_properties + ' properties · ' + counts.other_assets + ' assets · ' + counts.other_liabilities + ' liabilities across UBOs</div>' +
          '</div>' +
          // INCOME / EXPENSE side
          '<div style="background:rgba(78,161,255,0.04);border:1px solid rgba(78,161,255,0.25);border-radius:6px;padding:12px;">' +
            '<div style="font-size:11px;color:#4EA1FF;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">💰 Consolidated Income & Expenses (monthly)</div>' +
            '<table style="width:100%;font-size:12px;">' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">Income (effective monthly)</td><td style="text-align:right;color:#34D399;font-weight:600;">' + _money(cie.effective_monthly_income) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">Expense (effective monthly)</td><td style="text-align:right;color:#F87171;font-weight:600;">−' + _money(cie.effective_monthly_expense) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06);"><strong>= Net monthly</strong></td><td style="text-align:right;color:' + netColor + ';font-weight:700;border-bottom:1px solid rgba(255,255,255,0.06);">' + _money(cie.effective_monthly_net) + '</td></tr>' +
              '<tr><td style="color:#94A3B8;padding:3px 0;">Property net rent (rent − interest)</td><td style="text-align:right;color:#34D399;">' + _money(cie.effective_monthly_net_rent) + '</td></tr>' +
              '<tr><td style="color:#4EA1FF;padding:6px 0 3px;border-top:2px solid rgba(78,161,255,0.4);font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:11px;">Disposable monthly</td><td style="text-align:right;color:' + netColor + ';font-weight:800;font-size:14px;border-top:2px solid rgba(78,161,255,0.4);padding-top:6px;">' + _money(Number(cie.effective_monthly_net || 0) + Number(cie.effective_monthly_net_rent || 0)) + '</td></tr>' +
            '</table>' +
            '<div style="margin-top:8px;font-size:10px;color:#64748B;">' + counts.income_lines + ' income lines · ' + counts.expense_lines + ' expense lines across UBOs</div>' +
          '</div>' +
        '</div>';
    } catch (err) {
      host.innerHTML = '<div style="color:#F87171;padding:6px;">Consolidated rollup load failed: ' + _esc(err.message) + '</div>';
    }
  };

  window._buildBalanceSheetSection = function (deal) {
    if (!deal || !deal.id) return '';
    // Sprint 4 #21 — also kick off the consolidated rollup loader. The host
    // div lives in deal-matrix.js (#consolidated-bs-host inside the
    // Consolidated A/L + I/E sub-row).
    setTimeout(() => window._loadConsolidatedBalanceSheet && window._loadConsolidatedBalanceSheet(deal.id), 500);
    const borrowers = (deal.borrowers || []).filter(b => b && b.id);
    // Filter to INDIVIDUAL borrowers only (UBOs, directors, joint individuals,
    // individual guarantors). Skip corporate borrowers — they have CH data
    // not a personal balance sheet.
    const individuals = borrowers.filter(b => {
      const t = (b.borrower_type || '').toLowerCase();
      return t === 'individual' || (!t && b.full_name && !b.company_number);
    });

    if (individuals.length === 0) {
      return '<div style="padding:14px;font-size:12px;color:#94A3B8;font-style:italic;">No individual borrowers/UBOs on this deal yet. Add directors/UBOs/PSCs in the Borrower section first, then return here to capture their balance sheets.</div>';
    }

    let html = '<div id="bs-section" style="padding:6px 4px;">';
    individuals.forEach(b => {
      const role = b.role || 'individual';
      const rolePill = '<span style="font-size:9px;padding:2px 8px;border-radius:8px;background:rgba(212,168,83,0.12);color:#D4A853;text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-left:6px;">' + _esc(role) + '</span>';
      html += '<div style="background:#0F172A;border:1px solid rgba(255,255,255,0.06);border-left:3px solid #D4A853;border-radius:6px;margin-bottom:10px;overflow:hidden;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;background:rgba(212,168,83,0.04);" onclick="window._bsToggleBorrower(' + b.id + ')">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<span id="bs-chev-' + b.id + '" style="font-size:10px;color:#64748B;transition:transform 0.15s;">▶</span>' +
            '<span style="font-size:13px;font-weight:600;color:#F1F5F9;">' + _esc(b.full_name || 'Unnamed') + '</span>' +
            rolePill +
            '<span id="bs-summary-' + b.id + '" style="font-size:11px;color:#94A3B8;">Loading…</span>' +
          '</div>' +
        '</div>' +
        '<div id="bs-body-' + b.id + '" style="display:none;padding:10px 14px;border-top:1px solid rgba(255,255,255,0.04);">' +
          '<div style="font-size:11px;color:#94A3B8;text-align:center;padding:10px;">Click to expand…</div>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';

    // Defer auto-load summaries
    setTimeout(() => {
      individuals.forEach(b => _refreshSummary(b.id));
    }, 200);

    return html;
  };

  // ════════════════════════════════════════════════════════════
  // Per-borrower expand
  // ════════════════════════════════════════════════════════════

  window._bsToggleBorrower = async function (borrowerId) {
    const body = document.getElementById('bs-body-' + borrowerId);
    const chev = document.getElementById('bs-chev-' + borrowerId);
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    if (isOpen) {
      body.style.display = 'none';
      if (chev) chev.style.transform = 'rotate(0deg)';
      return;
    }
    body.style.display = 'block';
    if (chev) chev.style.transform = 'rotate(90deg)';
    body.innerHTML = '<div style="font-size:11px;color:#94A3B8;padding:10px;">Loading balance sheet…</div>';
    await _renderBorrowerFull(borrowerId);
  };

  async function _refreshSummary(borrowerId) {
    try {
      const j = await _api('/api/admin/balance-sheet/borrower/' + borrowerId + '/net-worth');
      const d = j.data || {};
      const summary = document.getElementById('bs-summary-' + borrowerId);
      if (!summary) return;
      const counts = '· ' + d.portfolio_properties_count + ' properties · ' +
                     d.other_assets_count + ' assets · ' +
                     d.other_liabilities_count + ' liabilities';
      const nw = '· Net worth: <strong style="color:#34D399;">' + _money(d.effective_net_worth) + '</strong>';
      summary.innerHTML = counts + ' ' + nw;
    } catch (err) {
      // silent
    }
  }

  async function _renderBorrowerFull(borrowerId) {
    const body = document.getElementById('bs-body-' + borrowerId);
    if (!body) return;
    try {
      const j = await _api('/api/admin/balance-sheet/borrower/' + borrowerId + '/net-worth');
      const d = j.data || {};
      body.innerHTML = _renderFullHtml(borrowerId, d);
      _refreshSummary(borrowerId);
    } catch (err) {
      body.innerHTML = '<div style="font-size:11px;color:#F87171;padding:10px;">Failed to load: ' + _esc(err.message) + '</div>';
    }
  }

  function _renderFullHtml(borrowerId, d) {
    const props = d.portfolio || [];
    const assets = (d.other_assets_liabilities || []).filter(r => r.kind === 'asset');
    const liabs = (d.other_assets_liabilities || []).filter(r => r.kind === 'liability');

    // Sprint 4 #22 / Sprint 5 #24 — embed directorships block; pass identity
    // for Find at CH search prefill (name + DoB)
    const dsBlock = (typeof window._buildDirectorshipsBlock === 'function')
      ? window._buildDirectorshipsBlock({
          id: borrowerId,
          full_name: d.full_name || null,
          date_of_birth: d.date_of_birth || null
        })
      : '';

    // Sprint 4 #20 — income/expenses block (lazy-loaded after DOM render)
    const ieBlock = '<div id="bs-ie-' + borrowerId + '" style="margin-top:14px;">' +
      '<div style="font-size:11px;color:#94A3B8;padding:6px;font-style:italic;">Loading income & expenses…</div>' +
    '</div>';
    setTimeout(() => _refreshIncomeExpenses(borrowerId), 100);

    return _renderPortfolioBlock(borrowerId, props, d) +
           _renderAssetsLiabsBlock(borrowerId, assets, liabs, d) +
           ieBlock +
           _renderRollupBlock(d) +
           dsBlock;
  }

  // Sprint 4 #20 — fetch and render the income/expenses sub-block
  async function _refreshIncomeExpenses(borrowerId) {
    const host = document.getElementById('bs-ie-' + borrowerId);
    if (!host) return;
    try {
      const j = await _api('/api/admin/balance-sheet/borrower/' + borrowerId + '/income-expenses');
      const d = j.data || {};
      host.innerHTML = _renderIeBlock(borrowerId, d);
    } catch (err) {
      host.innerHTML = '<div style="font-size:11px;color:#F87171;padding:6px;">Income/expenses load failed: ' + _esc(err.message) + '</div>';
    }
  }

  function _renderIeBlock(borrowerId, d) {
    const incomes = d.incomes || [];
    const expenses = d.expenses || [];
    const renderList = (rows, kind, color) => {
      if (rows.length === 0) {
        return '<div style="font-size:11px;color:#94A3B8;font-style:italic;padding:6px;">No ' + kind + 's yet.</div>';
      }
      return rows.map(r => {
        const monthly = (r.derived && r.derived.monthly_gross) || 0;
        const monthlyEff = (r.derived && r.derived.monthly_effective) || 0;
        return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">' +
          '<div>' +
            '<div style="color:#F1F5F9;font-weight:500;">' + _esc(r.description || r.category || '—') + '</div>' +
            '<div style="font-size:10px;color:#94A3B8;">' + _esc(r.category || '') +
              (r.frequency ? ' · ' + _esc(r.frequency) : '') +
              (r.ownership_pct != null && r.ownership_pct < 100 ? ' · ' + _pct(r.ownership_pct) + ' owned' : '') +
            '</div>' +
          '</div>' +
          '<div style="text-align:right;display:flex;gap:8px;align-items:center;">' +
            '<div>' +
              '<div style="color:' + color + ';font-weight:600;">' + _money(r.amount) + ' / ' + _esc(r.frequency || 'monthly') + '</div>' +
              '<div style="font-size:10px;color:#94A3B8;">~' + _money(monthly) + '/mo' + (r.ownership_pct != null && r.ownership_pct < 100 ? ' · eff ' + _money(monthlyEff) + '/mo' : '') + '</div>' +
            '</div>' +
            '<button onclick="window._bsDeleteIncomeExpense(' + r.id + ', ' + borrowerId + ')" style="padding:2px 6px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove">×</button>' +
          '</div>' +
        '</div>';
      }).join('');
    };

    const netColor = d.effective_monthly_net >= 0 ? '#34D399' : '#F87171';
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px;">' +
      '<div style="background:rgba(52,211,153,0.04);border:1px solid rgba(52,211,153,0.2);border-radius:6px;padding:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<div style="font-size:11px;color:#34D399;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">📈 Income</div>' +
          '<button onclick="window._bsAddIncomeExpense(' + borrowerId + ', \'income\')" style="padding:3px 8px;background:#34D399;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add</button>' +
        '</div>' +
        renderList(incomes, 'income', '#34D399') +
        '<div style="display:flex;justify-content:space-between;padding-top:8px;margin-top:6px;border-top:1px solid rgba(52,211,153,0.25);font-size:13px;font-weight:700;color:#34D399;">' +
          '<span>Effective monthly income</span><span>' + _money(d.effective_monthly_income) + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="background:rgba(248,113,113,0.04);border:1px solid rgba(248,113,113,0.2);border-radius:6px;padding:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<div style="font-size:11px;color:#F87171;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">📉 Expenses</div>' +
          '<button onclick="window._bsAddIncomeExpense(' + borrowerId + ', \'expense\')" style="padding:3px 8px;background:#F87171;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add</button>' +
        '</div>' +
        renderList(expenses, 'expense', '#F87171') +
        '<div style="display:flex;justify-content:space-between;padding-top:8px;margin-top:6px;border-top:1px solid rgba(248,113,113,0.25);font-size:13px;font-weight:700;color:#F87171;">' +
          '<span>Effective monthly expense</span><span>' + _money(d.effective_monthly_expense) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div style="background:rgba(78,161,255,0.04);border:1px solid rgba(78,161,255,0.2);border-radius:6px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;">' +
      '<span style="color:#4EA1FF;text-transform:uppercase;letter-spacing:.04em;font-size:11px;">Net monthly (effective)</span>' +
      '<span style="color:' + netColor + ';">' + _money(d.effective_monthly_net) + '/mo</span>' +
    '</div>';
  }

  // Sprint 4 #20 — Add income/expense via prompts (matches existing v1 pattern)
  window._bsAddIncomeExpense = async function (borrowerId, kind) {
    const description = prompt(kind === 'income' ? 'Income source (e.g. "Salary @ Acme Ltd", "BTL rental"):' : 'Expense (e.g. "Mortgage on home", "School fees"):');
    if (!description) return;
    const category = prompt('Category (' + (kind === 'income' ? 'employment/self_employment/rental/dividend/pension/other_income' : 'mortgage/rent/utilities/living_costs/other_expense') + '):') || null;
    const amount = prompt('Amount (£):');
    const frequency = (prompt('Frequency (monthly / annually / one_off, default monthly):') || 'monthly').toLowerCase();
    const pct = prompt('Ownership % (default 100):') || 100;
    try {
      await _api('/api/admin/balance-sheet/borrower/' + borrowerId + '/income-expenses', {
        method: 'POST',
        body: JSON.stringify({
          kind, description, category,
          amount: Number(amount) || null,
          frequency,
          ownership_pct: Number(pct) || 100
        })
      });
      await _refreshIncomeExpenses(borrowerId);
      _refreshSummary(borrowerId);
    } catch (err) {
      alert('Add failed: ' + err.message);
    }
  };

  window._bsDeleteIncomeExpense = async function (id, borrowerId) {
    if (!confirm('Remove this row?')) return;
    try {
      await _api('/api/admin/balance-sheet/income-expenses/' + id, { method: 'DELETE' });
      await _refreshIncomeExpenses(borrowerId);
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  };

  function _renderPortfolioBlock(borrowerId, props, d) {
    const rowsHtml = props.length === 0
      ? '<tr><td colspan="9" style="padding:14px;text-align:center;color:#94A3B8;font-style:italic;">No portfolio properties yet.</td></tr>'
      : props.map(p => {
          const eq = (p.derived && p.derived.gross_equity) || 0;
          const effEq = (p.derived && p.derived.effective_equity) || 0;
          const netRent = (p.derived && p.derived.net_rent_monthly_gross) || 0;
          const effNetRent = (p.derived && p.derived.net_rent_monthly_effective) || 0;
          return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
            '<td style="padding:6px 8px;color:#F1F5F9;font-weight:500;">' + _esc(p.address || '—') + '</td>' +
            '<td style="padding:6px 8px;color:#94A3B8;font-size:11px;">' + _esc(p.postcode || '') + '</td>' +
            '<td style="padding:6px 8px;text-align:right;">' + _money(p.market_value) + '</td>' +
            '<td style="padding:6px 8px;text-align:right;">' + _money(p.mortgage_outstanding) + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:#34D399;font-weight:600;">' + _money(eq) + '</td>' +
            '<td style="padding:6px 8px;text-align:right;">' + _money(p.monthly_rent) + ' / ' + _money(p.monthly_interest) + '</td>' +
            '<td style="padding:6px 8px;text-align:right;color:' + (netRent >= 0 ? '#34D399' : '#F87171') + ';font-weight:600;">' + _money(netRent) + '/mo</td>' +
            '<td style="padding:6px 8px;text-align:center;">' + _pct(p.ownership_pct || 100) + '</td>' +
            '<td style="padding:6px 8px;text-align:center;"><button onclick="window._bsDeletePortfolio(' + p.id + ', ' + borrowerId + ')" style="padding:2px 8px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove">×</button></td>' +
          '</tr>';
        }).join('');

    const totalsRow = props.length > 0
      ? '<tr style="border-top:2px solid rgba(212,168,83,0.4);background:rgba(212,168,83,0.03);font-weight:700;">' +
          '<td colspan="2" style="padding:8px;color:#D4A853;text-transform:uppercase;font-size:10px;letter-spacing:.04em;">Effective totals</td>' +
          '<td style="padding:8px;text-align:right;color:#F1F5F9;">' + _money(props.reduce((s,p) => s + Number((p.derived && p.derived.effective_market_value) || 0), 0)) + '</td>' +
          '<td style="padding:8px;text-align:right;color:#F1F5F9;">' + _money(props.reduce((s,p) => s + Number((p.derived && p.derived.effective_mortgage) || 0), 0)) + '</td>' +
          '<td style="padding:8px;text-align:right;color:#34D399;">' + _money(d.effective_property_equity) + '</td>' +
          '<td style="padding:8px;"></td>' +
          '<td style="padding:8px;text-align:right;color:#34D399;">' + _money(d.effective_monthly_net_rent) + '/mo</td>' +
          '<td colspan="2"></td>' +
        '</tr>'
      : '';

    return '<div style="margin-bottom:14px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<div style="font-size:11px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">📋 Property Portfolio</div>' +
        '<button onclick="window._bsAddPortfolioProperty(' + borrowerId + ')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Property</button>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="background:rgba(255,255,255,0.04);">' +
          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Address</th>' +
          '<th style="text-align:left;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Postcode</th>' +
          '<th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Mkt value</th>' +
          '<th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Mortgage</th>' +
          '<th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Equity</th>' +
          '<th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);" title="Monthly rent / interest">Rent / Int</th>' +
          '<th style="text-align:right;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Net rent</th>' +
          '<th style="text-align:center;padding:6px 8px;color:#94A3B8;font-weight:600;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.08);">Own %</th>' +
          '<th style="width:40px;border-bottom:1px solid rgba(255,255,255,0.08);"></th>' +
        '</tr></thead>' +
        '<tbody>' + rowsHtml + totalsRow + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function _renderAssetsLiabsBlock(borrowerId, assets, liabs, d) {
    const renderList = (rows, kind, color) => {
      if (rows.length === 0) {
        return '<div style="font-size:11px;color:#94A3B8;font-style:italic;padding:8px;">No ' + kind + 's yet.</div>';
      }
      return rows.map(r => {
        const eff = (r.derived && r.derived.effective_amount) || 0;
        return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">' +
          '<div>' +
            '<div style="color:#F1F5F9;font-weight:500;">' + _esc(r.description || r.category || '—') + '</div>' +
            '<div style="font-size:10px;color:#94A3B8;">' + _esc(r.category || '') + (r.ownership_pct != null && r.ownership_pct < 100 ? ' · ' + _pct(r.ownership_pct) + ' owned' : '') + '</div>' +
          '</div>' +
          '<div style="text-align:right;display:flex;gap:8px;align-items:center;">' +
            '<div>' +
              '<div style="color:' + color + ';font-weight:600;">' + _money(r.amount) + '</div>' +
              (r.ownership_pct != null && r.ownership_pct < 100 ? '<div style="font-size:10px;color:#94A3B8;">eff: ' + _money(eff) + '</div>' : '') +
            '</div>' +
            '<button onclick="window._bsDeleteAssetLiab(' + r.id + ', ' + borrowerId + ')" style="padding:2px 6px;background:rgba(248,113,113,0.1);color:#F87171;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;" title="Remove">×</button>' +
          '</div>' +
        '</div>';
      }).join('');
    };

    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">' +
      '<div style="background:rgba(52,211,153,0.04);border:1px solid rgba(52,211,153,0.2);border-radius:6px;padding:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<div style="font-size:11px;color:#34D399;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">💰 Other Assets</div>' +
          '<button onclick="window._bsAddAssetLiab(' + borrowerId + ', \'asset\')" style="padding:3px 8px;background:#34D399;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add</button>' +
        '</div>' +
        renderList(assets, 'asset', '#34D399') +
        '<div style="display:flex;justify-content:space-between;padding-top:8px;margin-top:6px;border-top:1px solid rgba(52,211,153,0.25);font-size:13px;font-weight:700;color:#34D399;">' +
          '<span>Total assets (effective)</span><span>' + _money(d.effective_other_assets) + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="background:rgba(248,113,113,0.04);border:1px solid rgba(248,113,113,0.2);border-radius:6px;padding:10px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<div style="font-size:11px;color:#F87171;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">💳 Liabilities</div>' +
          '<button onclick="window._bsAddAssetLiab(' + borrowerId + ', \'liability\')" style="padding:3px 8px;background:#F87171;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add</button>' +
        '</div>' +
        renderList(liabs, 'liability', '#F87171') +
        '<div style="display:flex;justify-content:space-between;padding-top:8px;margin-top:6px;border-top:1px solid rgba(248,113,113,0.25);font-size:13px;font-weight:700;color:#F87171;">' +
          '<span>Total liabilities (effective)</span><span>' + _money(d.effective_other_liabilities) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function _renderRollupBlock(d) {
    return '<div style="background:rgba(78,161,255,0.06);border:1px solid rgba(78,161,255,0.25);border-left:3px solid #4EA1FF;border-radius:6px;padding:10px 14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">' +
        '<div style="font-size:11px;color:#4EA1FF;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">⚖ Net Worth Roll-up (effective)</div>' +
        '<div style="font-size:18px;font-weight:800;color:#34D399;">' + _money(d.effective_net_worth) + '</div>' +
      '</div>' +
      '<div style="font-size:11px;color:#94A3B8;margin-top:6px;line-height:1.7;">' +
        'Property equity ' + _money(d.effective_property_equity) +
        ' + Other assets ' + _money(d.effective_other_assets) +
        ' − Liabilities ' + _money(d.effective_other_liabilities) +
        ' = <strong style="color:#34D399;">' + _money(d.effective_net_worth) + '</strong>' +
        ' · Monthly net rent: <strong style="color:#34D399;">' + _money(d.effective_monthly_net_rent) + '/mo</strong>' +
      '</div>' +
    '</div>';
  }

  // ════════════════════════════════════════════════════════════
  // Add / Delete actions
  // ════════════════════════════════════════════════════════════

  window._bsAddPortfolioProperty = async function (borrowerId) {
    const address = prompt('Property address:');
    if (!address) return;
    const postcode = prompt('Postcode:') || null;
    const mv = prompt('Market value (£):');
    const mortgage = prompt('Mortgage outstanding (£):') || 0;
    const rent = prompt('Monthly rent (£) — 0 if not let:') || 0;
    const interest = prompt('Monthly mortgage interest (£):') || 0;
    const pct = prompt('Ownership % (default 100):') || 100;
    try {
      await _api('/api/admin/balance-sheet/borrower/' + borrowerId + '/portfolio', {
        method: 'POST',
        body: JSON.stringify({
          address, postcode,
          market_value: Number(mv) || null,
          mortgage_outstanding: Number(mortgage) || null,
          monthly_rent: Number(rent) || null,
          monthly_interest: Number(interest) || null,
          ownership_pct: Number(pct) || 100
        })
      });
      await _renderBorrowerFull(borrowerId);
    } catch (err) {
      alert('Add failed: ' + err.message);
    }
  };

  window._bsAddAssetLiab = async function (borrowerId, kind) {
    const description = prompt(kind === 'asset' ? 'Asset description (e.g. "Cash @ Barclays", "Director loan"):' : 'Liability description (e.g. "Personal loan", "Credit card"):');
    if (!description) return;
    const category = prompt('Category (cash/investment/personal_loan/credit_card/other):') || null;
    const amount = prompt(kind === 'asset' ? 'Amount (£):' : 'Outstanding balance (£):');
    const pct = prompt('Ownership % (default 100):') || 100;
    try {
      await _api('/api/admin/balance-sheet/borrower/' + borrowerId + '/other', {
        method: 'POST',
        body: JSON.stringify({
          kind, description, category,
          amount: Number(amount) || null,
          ownership_pct: Number(pct) || 100
        })
      });
      await _renderBorrowerFull(borrowerId);
    } catch (err) {
      alert('Add failed: ' + err.message);
    }
  };

  window._bsDeletePortfolio = async function (id, borrowerId) {
    if (!confirm('Remove this property from the portfolio?')) return;
    try {
      await _api('/api/admin/balance-sheet/portfolio/' + id, { method: 'DELETE' });
      await _renderBorrowerFull(borrowerId);
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  };

  window._bsDeleteAssetLiab = async function (id, borrowerId) {
    if (!confirm('Remove this row?')) return;
    try {
      await _api('/api/admin/balance-sheet/other/' + id, { method: 'DELETE' });
      await _renderBorrowerFull(borrowerId);
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  };

  console.log('[balance-sheet-panel] Loaded — window._buildBalanceSheetSection available');
})();
