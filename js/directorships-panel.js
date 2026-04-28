/**
 * js/directorships-panel.js — Sprint 4 #22 (2026-04-28)
 * ============================================================
 * CH "Other Directorships" KYC display panel for each individual
 * borrower (UBO/director/PSC/joint/guarantor) in the Borrower
 * section of the matrix.
 *
 * Sets:
 *   window._buildDirectorshipsBlock(borrower)  — render summary block
 *   window._dsPullForBorrower(borrowerId)
 *   window._dsToggleAll(borrowerId)
 *
 * Data source: GET /api/admin/directorships/borrower/:id/summary
 * (and .../all when "show all" toggled).
 *
 * Default view = aggregates strip + troublesome list. "Show all" reveals
 * the full appointment list (current + resigned).
 *
 * Pull button calls POST /api/admin/directorships/borrower/:id/pull —
 * auto-discovers ch_officer_id from deal_borrowers.ch_match_data.
 * ============================================================
 */

(function () {
  if (window._buildDirectorshipsBlock) return;

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

  function _fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return String(iso).substring(0, 10); }
  }

  // ════════════════════════════════════════════════════════════
  // Render entry
  // ════════════════════════════════════════════════════════════

  /**
   * Returns the HTML for a directorships block to be embedded inside
   * a borrower's expanded card. Auto-fetches summary on render.
   *
   * Stores borrower name + DoB on the block element so Find at CH
   * search can pre-fill the query without a re-fetch.
   */
  window._buildDirectorshipsBlock = function (borrower) {
    if (!borrower || !borrower.id) return '';
    const bid = borrower.id;
    const fullName = _esc(borrower.full_name || '');
    let dobYear = '';
    let dobMonth = '';
    if (borrower.date_of_birth) {
      try {
        const d = new Date(borrower.date_of_birth);
        if (!isNaN(d.getTime())) {
          dobYear = String(d.getUTCFullYear());
          dobMonth = String(d.getUTCMonth() + 1);
        }
      } catch (_) {}
    }
    const html = '<div id="ds-block-' + bid + '" data-name="' + fullName + '" data-dob-year="' + dobYear + '" data-dob-month="' + dobMonth + '" style="margin-top:10px;padding:10px 12px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.2);border-left:3px solid #A78BFA;border-radius:6px;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-size:10px;color:#A78BFA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">🔍 CH Other Directorships</span>' +
          '<span id="ds-summary-' + bid + '" style="font-size:11px;color:#94A3B8;">Loading…</span>' +
        '</div>' +
        '<div id="ds-actions-' + bid + '" style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button onclick="window._dsFindAtCh(' + bid + ')" style="padding:3px 10px;background:rgba(96,165,250,0.18);color:#60A5FA;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Manually search Companies House for this person">🔎 Find at CH</button>' +
          '<button onclick="window._dsPullForBorrower(' + bid + ')" style="padding:3px 10px;background:rgba(167,139,250,0.2);color:#A78BFA;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">↻ Pull from CH</button>' +
        '</div>' +
      '</div>' +
      '<div id="ds-troublesome-' + bid + '" style="font-size:12px;"></div>' +
      '<div id="ds-all-' + bid + '" style="display:none;margin-top:8px;padding-top:8px;border-top:1px dashed rgba(255,255,255,0.06);"></div>' +
      '<div id="ds-toggle-' + bid + '" style="margin-top:8px;text-align:center;"></div>' +
    '</div>';
    setTimeout(() => _refreshBlock(bid), 200);
    return html;
  };

  // ════════════════════════════════════════════════════════════
  // Refresh / render
  // ════════════════════════════════════════════════════════════

  async function _refreshBlock(borrowerId) {
    const summary = document.getElementById('ds-summary-' + borrowerId);
    const trouEl = document.getElementById('ds-troublesome-' + borrowerId);
    const toggleEl = document.getElementById('ds-toggle-' + borrowerId);
    if (!summary) return;
    try {
      const j = await _api('/api/admin/directorships/borrower/' + borrowerId + '/summary');
      const d = j.data || {};
      // Aggregates strip
      if (d.total_count === 0) {
        summary.innerHTML = '<span style="color:#94A3B8;">— No directorships data yet · click ↻ Pull from CH</span>';
        if (trouEl) trouEl.innerHTML = '';
        if (toggleEl) toggleEl.innerHTML = '';
        return;
      }
      const trCount = d.troublesome_count || 0;
      const aggParts = [
        '<strong style="color:#F1F5F9;">' + d.total_count + '</strong> total',
        '<strong>' + d.active_count + '</strong> active',
        '<strong>' + d.historical_count + '</strong> historical'
      ];
      if (trCount > 0) {
        aggParts.push('<strong style="color:#F87171;">⚠ ' + trCount + ' troublesome</strong>');
      } else {
        aggParts.push('<span style="color:#34D399;">✓ no flags</span>');
      }
      summary.innerHTML = aggParts.join(' · ');

      // Troublesome list (default visible)
      if (trEl_renderTroublesome(trouEl, d.troublesome || [])) {
        // rendered
      }

      // Show-all toggle button
      if (toggleEl) {
        toggleEl.innerHTML =
          '<button onclick="window._dsToggleAll(' + borrowerId + ')" style="padding:3px 10px;background:rgba(255,255,255,0.04);color:#94A3B8;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Show all ' + d.total_count + ' directorships ▾</button>';
      }
    } catch (err) {
      summary.innerHTML = '<span style="color:#F87171;">Failed: ' + _esc(err.message) + '</span>';
    }
  }

  function trEl_renderTroublesome(el, rows) {
    if (!el) return false;
    if (!rows || rows.length === 0) {
      el.innerHTML = '';
      return true;
    }
    el.innerHTML = rows.map(r => {
      const reasons = (r.troublesome_reasons || []).map(x => x.replace(/_/g, ' '));
      return '<div style="padding:6px 10px;background:rgba(248,113,113,0.06);border-left:2px solid #F87171;border-radius:3px;margin-bottom:4px;font-size:11px;">' +
        '<div style="color:#F87171;font-weight:600;">🚩 ' + _esc(r.company_name || '—') + ' · ' + _esc(r.company_number || '') + ' · ' + _esc((r.officer_role || '').toUpperCase()) + ' · <span style="color:#FBBF24;text-transform:uppercase;">' + _esc((r.company_status || '').toUpperCase()) + '</span></div>' +
        '<div style="color:#FED7AA;margin-top:2px;">Reason: ' + _esc(reasons.join(', ')) + '</div>' +
        '<div style="color:#94A3B8;font-size:10px;margin-top:2px;">Appointed ' + _fmtDate(r.appointment_date) + (r.resignation_date ? ' · Resigned ' + _fmtDate(r.resignation_date) : '') + ' · ' +
          '<a href="https://find-and-update.company-information.service.gov.uk/company/' + _esc(r.company_number) + '" target="_blank" rel="noopener" style="color:#60A5FA;text-decoration:none;">↗ CH</a>' +
        '</div>' +
      '</div>';
    }).join('');
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // Actions
  // ════════════════════════════════════════════════════════════

  window._dsPullForBorrower = async function (borrowerId) {
    const summary = document.getElementById('ds-summary-' + borrowerId);
    if (summary) summary.innerHTML = '<span style="color:#FBBF24;">⟳ Pulling from Companies House…</span>';
    try {
      const j = await _api('/api/admin/directorships/borrower/' + borrowerId + '/pull', { method: 'POST' });
      const r = j.data || {};
      if (r.skipped) {
        if (summary) summary.innerHTML = '<span style="color:#F87171;">Skipped — no ch_officer_id. Click 🔎 Find at CH to search manually.</span>';
        return;
      }
      // Refresh display
      await _refreshBlock(borrowerId);
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (/no ch_officer_id/i.test(msg)) {
        if (summary) summary.innerHTML = '<span style="color:#F87171;">No CH officer linked yet. Click 🔎 Find at CH to search and pick this person\'s Companies House record.</span>';
      } else {
        if (summary) summary.innerHTML = '<span style="color:#F87171;">Pull failed: ' + _esc(msg) + '</span>';
      }
    }
  };

  // ════════════════════════════════════════════════════════════
  // Sprint 5 #24 — "Find at CH" manual search + pick modal
  // ════════════════════════════════════════════════════════════

  window._dsFindAtCh = function (borrowerId) {
    const block = document.getElementById('ds-block-' + borrowerId);
    if (!block) return;
    const initialName = block.getAttribute('data-name') || '';
    const dobYear = block.getAttribute('data-dob-year') || '';
    const dobMonth = block.getAttribute('data-dob-month') || '';
    _openSearchModal(borrowerId, initialName, dobYear, dobMonth);
  };

  function _openSearchModal(borrowerId, initialName, dobYear, dobMonth) {
    // Tear down any previous modal
    const prev = document.getElementById('ds-search-modal');
    if (prev) prev.remove();

    const modal = document.createElement('div');
    modal.id = 'ds-search-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:60px 20px;overflow-y:auto;';
    modal.innerHTML =
      '<div style="background:#0F172A;border:1px solid rgba(167,139,250,0.3);border-radius:8px;width:100%;max-width:720px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,0.5);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
          '<div style="font-size:13px;color:#A78BFA;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">🔎 Find at Companies House</div>' +
          '<button onclick="document.getElementById(\'ds-search-modal\').remove()" style="background:transparent;color:#94A3B8;border:none;font-size:18px;cursor:pointer;line-height:1;">×</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#94A3B8;margin-bottom:10px;">Search the CH officer index. Pick the matching record to enable the "Pull from CH" button.</div>' +
        '<div style="display:grid;grid-template-columns:1fr 90px 90px auto;gap:6px;margin-bottom:10px;">' +
          '<input id="ds-search-q" type="text" placeholder="Officer name" value="' + _esc(initialName) + '" style="padding:6px 8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#F1F5F9;border-radius:4px;font-size:12px;" />' +
          '<input id="ds-search-dob-year" type="number" placeholder="DoB yr" value="' + _esc(dobYear) + '" style="padding:6px 8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#F1F5F9;border-radius:4px;font-size:12px;" />' +
          '<input id="ds-search-dob-month" type="number" placeholder="DoB mo" min="1" max="12" value="' + _esc(dobMonth) + '" style="padding:6px 8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#F1F5F9;border-radius:4px;font-size:12px;" />' +
          '<button onclick="window._dsRunSearch(' + borrowerId + ')" style="padding:6px 14px;background:#A78BFA;color:#0F172A;border:none;border-radius:4px;font-weight:700;font-size:12px;cursor:pointer;">Search</button>' +
        '</div>' +
        '<div id="ds-search-results" style="max-height:380px;overflow-y:auto;border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:6px;background:rgba(0,0,0,0.2);">' +
          '<div style="color:#94A3B8;font-size:11px;padding:20px;text-align:center;">Press Search to query Companies House.</div>' +
        '</div>' +
        '<div style="font-size:10px;color:#64748B;margin-top:8px;">DoB filter is applied client-side — leave blank to skip filtering by year/month.</div>' +
      '</div>';

    document.body.appendChild(modal);

    // Auto-search on open if we already have a name
    if (initialName) {
      setTimeout(() => window._dsRunSearch(borrowerId), 200);
    }

    // Close on backdrop click
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.remove();
    });

    // Enter key triggers search
    const qEl = document.getElementById('ds-search-q');
    if (qEl) qEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') window._dsRunSearch(borrowerId);
    });
  }

  window._dsRunSearch = async function (borrowerId) {
    const qEl = document.getElementById('ds-search-q');
    const yEl = document.getElementById('ds-search-dob-year');
    const mEl = document.getElementById('ds-search-dob-month');
    const out = document.getElementById('ds-search-results');
    if (!qEl || !out) return;
    const q = qEl.value.trim();
    if (!q || q.length < 2) {
      out.innerHTML = '<div style="color:#F87171;font-size:11px;padding:14px;text-align:center;">Enter at least 2 characters.</div>';
      return;
    }
    out.innerHTML = '<div style="color:#FBBF24;font-size:11px;padding:14px;text-align:center;">⟳ Searching Companies House…</div>';
    const params = ['q=' + encodeURIComponent(q)];
    if (yEl && yEl.value) params.push('dob_year=' + encodeURIComponent(yEl.value));
    if (mEl && mEl.value) params.push('dob_month=' + encodeURIComponent(mEl.value));
    try {
      const j = await _api('/api/admin/directorships/officer-search?' + params.join('&'));
      const rows = j.data || [];
      if (!rows.length) {
        out.innerHTML = '<div style="color:#94A3B8;font-size:11px;padding:14px;text-align:center;">No officers matched. Try removing DoB filters or simplifying the name.</div>';
        return;
      }
      out.innerHTML = rows.map(r => {
        const dob = r.date_of_birth
          ? (r.date_of_birth.month ? r.date_of_birth.month + '/' : '') + r.date_of_birth.year
          : '—';
        const apptCount = r.appointment_count != null ? r.appointment_count : '?';
        const safeOid = _esc(r.officer_id);
        const safeName = _esc(r.title);
        return '<div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:200px;">' +
            '<div style="color:#F1F5F9;font-weight:600;font-size:12px;">' + safeName + '</div>' +
            '<div style="color:#94A3B8;font-size:10px;margin-top:2px;">DoB ' + _esc(dob) + ' · ' + _esc(apptCount) + ' appointment' + (apptCount === 1 ? '' : 's') + (r.address_snippet ? ' · ' + _esc(r.address_snippet) : '') + '</div>' +
            '<div style="color:#64748B;font-size:9px;margin-top:1px;font-family:monospace;">officer_id: ' + safeOid + '</div>' +
          '</div>' +
          '<button onclick="window._dsPickOfficer(' + borrowerId + ',\'' + safeOid + '\',\'' + safeName.replace(/'/g, "&#039;") + '\')" style="padding:5px 12px;background:#34D399;color:#0F172A;border:none;border-radius:4px;font-weight:700;font-size:11px;cursor:pointer;">✓ Pick</button>' +
        '</div>';
      }).join('');
    } catch (err) {
      out.innerHTML = '<div style="color:#F87171;font-size:11px;padding:14px;text-align:center;">Search failed: ' + _esc(err.message) + '</div>';
    }
  };

  window._dsPickOfficer = async function (borrowerId, officerId, chName) {
    if (!officerId) return;
    const out = document.getElementById('ds-search-results');
    if (out) out.innerHTML = '<div style="color:#FBBF24;font-size:11px;padding:14px;text-align:center;">⟳ Linking + pulling appointments…</div>';
    try {
      // 1. Save officer_id
      await _api('/api/admin/directorships/borrower/' + borrowerId + '/officer-id', {
        method: 'PUT',
        body: JSON.stringify({ officer_id: officerId, ch_name: chName || null })
      });
      // 2. Trigger pull
      await _api('/api/admin/directorships/borrower/' + borrowerId + '/pull', { method: 'POST' });
      // 3. Close modal + refresh inline block
      const modal = document.getElementById('ds-search-modal');
      if (modal) modal.remove();
      await _refreshBlock(borrowerId);
    } catch (err) {
      if (out) out.innerHTML = '<div style="color:#F87171;font-size:11px;padding:14px;text-align:center;">Link failed: ' + _esc(err.message) + '</div>';
    }
  };

  window._dsToggleAll = async function (borrowerId) {
    const allEl = document.getElementById('ds-all-' + borrowerId);
    const toggleEl = document.getElementById('ds-toggle-' + borrowerId);
    if (!allEl) return;
    const isOpen = allEl.style.display !== 'none';
    if (isOpen) {
      allEl.style.display = 'none';
      if (toggleEl) {
        const btn = toggleEl.querySelector('button');
        if (btn) btn.innerHTML = btn.innerHTML.replace('▴', '▾');
      }
      return;
    }
    // Fetch full list
    allEl.innerHTML = '<div style="color:#94A3B8;font-size:11px;padding:6px;">Loading full list…</div>';
    allEl.style.display = 'block';
    try {
      const j = await _api('/api/admin/directorships/borrower/' + borrowerId + '/all');
      const rows = j.data || [];
      if (rows.length === 0) {
        allEl.innerHTML = '<div style="color:#94A3B8;font-size:11px;padding:6px;font-style:italic;">No directorships on file.</div>';
        return;
      }
      const active = rows.filter(r => r.is_active);
      const historical = rows.filter(r => !r.is_active);
      const renderRow = (r) => {
        const flagged = r.is_troublesome ? '<span style="color:#F87171;font-weight:700;">🚩</span> ' : '';
        const statusColor = r.is_active ? '#34D399' : '#94A3B8';
        return '<div style="padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
          '<div>' + flagged + '<span style="color:#F1F5F9;">' + _esc(r.company_name || '—') + '</span> <span style="color:#94A3B8;">(' + _esc(r.company_number || '') + ')</span></div>' +
          '<div style="color:' + statusColor + ';font-size:10px;">' + _esc((r.company_status || '').toUpperCase()) + ' · ' + _esc((r.officer_role || '').toUpperCase()) + ' · ' + _fmtDate(r.appointment_date) + (r.resignation_date ? '→' + _fmtDate(r.resignation_date) : '→ now') + '</div>' +
        '</div>';
      };
      allEl.innerHTML =
        '<div style="font-size:10px;color:#34D399;text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:4px;">Active (' + active.length + ')</div>' +
        (active.length ? active.map(renderRow).join('') : '<div style="color:#94A3B8;font-size:11px;padding:4px;font-style:italic;">None</div>') +
        '<div style="font-size:10px;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin:8px 0 4px;">Historical (' + historical.length + ')</div>' +
        (historical.length ? historical.map(renderRow).join('') : '<div style="color:#94A3B8;font-size:11px;padding:4px;font-style:italic;">None</div>');
      if (toggleEl) {
        const btn = toggleEl.querySelector('button');
        if (btn) btn.innerHTML = btn.innerHTML.replace('▾', '▴').replace(/Show all .* directorships/, 'Hide list');
      }
    } catch (err) {
      allEl.innerHTML = '<div style="color:#F87171;font-size:11px;padding:6px;">Failed: ' + _esc(err.message) + '</div>';
    }
  };

  console.log('[directorships-panel] Loaded — window._buildDirectorshipsBlock available');
})();
