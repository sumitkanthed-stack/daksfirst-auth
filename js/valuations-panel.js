/**
 * js/valuations-panel.js — RICS valuation panel for the deal matrix
 * ============================================================
 * Per-property panel rendering active + historic RICS valuations,
 * with add/edit/finalise/supersede flows + PDF upload via existing
 * deal_documents endpoint.
 *
 * Sets:
 *   window._buildValuationsPanel(p, deal)  — render panel HTML for a property
 *   window._valOpenAdd(propertyId, dealId)
 *   window._valOpenEdit(valuationId)
 *   window._valFinalise(valuationId, dealId, dealSubmissionId)
 *   window._valOpenSupersede(valuationId, dealId, dealSubmissionId)
 *   window._valSaveDraft(...)
 *   window._valUploadDoc(valuationId, dealSubmissionId, fileInputId)
 *
 * Loaded via dynamic import in deal-detail.js immediately after deal-matrix.js.
 *
 * Sumit's design lock 2026-04-28:
 *   - Per-property card; appears below HMLR/Chimnie panels
 *   - Valuer dropdown sourced from /api/admin/panels/valuers?status=active
 *   - "Other (off-panel)" option toggles a free-text valuer name input;
 *     off-panel use is allowed but flagged in IA grade by the rubric
 *   - lending_value is the LTV anchor (validated at finalise)
 *   - 6-month expiry pill computed at SELECT-time
 *   - Append-only revisions via supersede (existing finalised vals
 *     are immutable; "Re-val" creates a new draft + supersedes)
 * ============================================================
 */

(function () {
  // Guard against double-load
  if (window._buildValuationsPanel) return;

  const _internalRoles = ['admin', 'rm', 'credit', 'compliance'];
  function _isAdmin() {
    // Liberal gate (2026-04-28 patch): if a session token exists, render
    // the panel. Backend's authenticateAdmin middleware enforces the real
    // role gate on every data call (/api/admin/valuations/*, /api/admin/panels/*).
    // Earlier JWT-decode approach silently failed for reasons we couldn't
    // pin down remotely; this avoids the foot-gun. Brokers don't see the
    // deal page in normal flow, so the cosmetic exposure is acceptable.
    return !!sessionStorage.getItem('daksfirst_token');
  }

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
    if (r.status === 401 || r.status === 403) throw new Error('Auth failed — please sign in as admin');
    if (!r.ok || j.success === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _money(pence) {
    if (pence == null) return '—';
    const p = Number(pence);
    if (!Number.isFinite(p)) return '—';
    return '£' + (p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function _date(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return iso; }
  }

  // Top-of-page toast (auto-dismiss). Used for save/upload/finalise feedback
  // outside the modal. Multiple toasts stack.
  function _toast(message, kind) {
    let host = document.getElementById('val-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'val-toast-host';
      host.style.cssText = 'position:fixed;top:20px;right:20px;z-index:300;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(host);
    }
    const colors = {
      success: { bg: 'rgba(62,207,142,0.95)', col: '#fff', border: '#2eb774' },
      error:   { bg: 'rgba(239,91,91,0.95)',  col: '#fff', border: '#d54a4a' },
      info:    { bg: 'rgba(78,161,255,0.95)', col: '#fff', border: '#3a8def' }
    };
    const c = colors[kind] || colors.info;
    const t = document.createElement('div');
    t.style.cssText = 'background:' + c.bg + ';color:' + c.col + ';border:1px solid ' + c.border + ';border-radius:6px;padding:10px 14px;font-size:13px;font-weight:500;max-width:480px;box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:auto;';
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.4s'; }, 4500);
    setTimeout(() => t.remove(), 5000);
  }

  // Status pill summarising the panel's overall state — appears in the
  // collapsed header so the underwriter knows whether RICS data exists
  // without expanding.
  function _statusPill(rows) {
    if (!rows || rows.length === 0) {
      return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:700;background:rgba(100,116,139,0.12);color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;">— No valuation</span>';
    }
    const finalised = rows.filter(r => r.status === 'finalised');
    const drafts = rows.filter(r => r.status === 'draft');
    if (finalised.length > 0) {
      const head = finalised[0];
      const expired = head.expiry && head.expiry.state === 'expired';
      if (expired) {
        return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:700;background:rgba(239,91,91,0.15);color:#F87171;text-transform:uppercase;letter-spacing:.04em;">✗ Expired</span>';
      }
      return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:700;background:rgba(62,207,142,0.15);color:#34D399;text-transform:uppercase;letter-spacing:.04em;">✓ Finalised</span>';
    }
    if (drafts.length > 0) {
      return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:700;background:rgba(244,183,64,0.15);color:#FBBF24;text-transform:uppercase;letter-spacing:.04em;">● Draft</span>';
    }
    return '';
  }

  function _expiryPill(exp) {
    if (!exp) return '';
    const map = {
      missing:       { txt: '— No date',           bg: 'rgba(100,116,139,0.12)', col: '#94A3B8' },
      valid:         { txt: '✓ Valid · ' + (exp.daysRemaining || 0) + 'd',
                       bg: 'rgba(52,211,153,0.12)', col: '#34D399' },
      expiring_soon: { txt: '⚠ Expiring · ' + (exp.daysRemaining || 0) + 'd',
                       bg: 'rgba(244,183,64,0.12)', col: '#FBBF24' },
      expired:       { txt: '✗ Expired',           bg: 'rgba(239,91,91,0.12)', col: '#F87171' }
    };
    const m = map[exp.state] || map.missing;
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:' + m.bg + ';color:' + m.col + ';">' + m.txt + '</span>';
  }

  // ════════════════════════════════════════════════════════════
  // PANEL RENDER (lazy fetches active vals when user expands)
  // ════════════════════════════════════════════════════════════

  window._buildValuationsPanel = function (p, deal) {
    if (!p || !p.id) return '';
    if (!_isAdmin()) return '';
    const subId = deal && (deal.submission_id || deal.id);
    if (!subId || !deal.id) return '';

    const propId = p.id;
    const containerId = 'val-panel-' + propId;
    const bodyId = 'val-body-' + propId;

    return '<div id="' + containerId + '" style="margin-top:8px;padding:10px 12px;background:rgba(212,168,83,0.04);border:1px solid rgba(212,168,83,0.25);border-radius:6px;">' +
      // Header (clickable to expand)
      '<div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;" onclick="window._valTogglePanel(' + propId + ', ' + deal.id + ')">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span id="val-chev-' + propId + '" style="font-size:10px;color:#64748B;transition:transform 0.15s;">▶</span>' +
          '<span style="font-size:10px;color:#D4A853;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">RICS Valuation</span>' +
          '<span id="val-statuspill-' + propId + '"></span>' +
          '<span id="val-summary-' + propId + '" style="font-size:11px;color:#94A3B8;">Loading…</span>' +
        '</div>' +
        '<div onclick="event.stopPropagation();" style="display:flex;gap:6px;">' +
          '<button onclick="window._valOpenAdd(' + propId + ', ' + deal.id + ')" style="padding:3px 10px;background:#D4A853;color:#0B1120;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">+ Add Valuation</button>' +
        '</div>' +
      '</div>' +
      '<div id="' + bodyId + '" style="display:none;margin-top:8px;"></div>' +
    '</div>';
  };

  window._valTogglePanel = async function (propId, dealId) {
    const body = document.getElementById('val-body-' + propId);
    const chev = document.getElementById('val-chev-' + propId);
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    if (isOpen) {
      body.style.display = 'none';
      if (chev) chev.style.transform = 'rotate(0deg)';
      return;
    }
    body.style.display = 'block';
    if (chev) chev.style.transform = 'rotate(90deg)';
    body.innerHTML = '<div style="font-size:11px;color:#94A3B8;padding:8px;">Loading valuations…</div>';
    try {
      const j = await _api('/api/admin/valuations/property/' + propId + '/' + dealId);
      _renderRows(propId, dealId, j.data || []);
    } catch (err) {
      body.innerHTML = '<div style="font-size:11px;color:#F87171;padding:8px;">Failed to load: ' + _esc(err.message) + '</div>';
    }
  };

  function _renderRows(propId, dealId, rows) {
    const body = document.getElementById('val-body-' + propId);
    const summary = document.getElementById('val-summary-' + propId);
    const pillSlot = document.getElementById('val-statuspill-' + propId);
    if (!body) return;
    // Status pill in header — visible whether expanded or not
    if (pillSlot) pillSlot.innerHTML = _statusPill(rows);
    if (summary) {
      if (rows.length === 0) summary.textContent = '';
      else {
        const head = rows[0];
        const firm = head.valuer_firm_name || head.valuer_off_panel_name || 'Unknown';
        summary.textContent = '· ' + firm + ' · ' + _money(head.lending_value_pence) + ' lending';
      }
    }
    if (rows.length === 0) {
      body.innerHTML = '<div style="font-size:12px;color:#94A3B8;font-style:italic;padding:6px 4px;">No valuation on file. Click "+ Add Valuation" to capture a RICS report.</div>';
      return;
    }
    body.innerHTML = rows.map(r => _rowCard(r, dealId)).join('');
  }

  function _rowCard(r, dealId) {
    const firm = r.valuer_firm_name || r.valuer_off_panel_name || 'Unknown';
    const offPanel = !r.valuer_id && !!r.valuer_off_panel_name;
    const offPanelBadge = offPanel
      ? '<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;background:rgba(244,183,64,0.15);color:#FBBF24;text-transform:uppercase;letter-spacing:.04em;margin-left:6px;">Off-panel</span>'
      : '';
    const expPill = _expiryPill(r.expiry);
    const docLink = r.document_id
      ? '<a href="' + _apiBase() + '/api/deals/' + dealId + '/documents/' + r.document_id + '/download" target="_blank" rel="noopener" style="font-size:10px;color:#60A5FA;text-decoration:none;font-weight:600;margin-left:8px;">↗ View PDF</a>'
      : '<span style="font-size:10px;color:#F87171;font-weight:600;margin-left:8px;">No PDF attached</span>';

    const isDraft = r.status === 'draft';
    const actions = isDraft
      ? '<button onclick="window._valOpenEdit(' + r.id + ')" style="padding:3px 10px;background:rgba(212,168,83,0.15);color:#D4A853;border:none;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;">Edit</button>' +
        '<button onclick="window._valFinalise(' + r.id + ', ' + dealId + ')" style="padding:3px 10px;background:rgba(52,211,153,0.15);color:#34D399;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Finalise</button>'
      : '<button onclick="window._valOpenSupersede(' + r.id + ', ' + dealId + ')" style="padding:3px 10px;background:rgba(78,161,255,0.15);color:#4EA1FF;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">Re-val (supersede)</button>';

    const statusPill = '<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700;text-transform:uppercase;background:' +
      (r.status === 'finalised' ? 'rgba(52,211,153,0.15);color:#34D399' :
       r.status === 'draft' ? 'rgba(244,183,64,0.15);color:#FBBF24' :
       'rgba(100,116,139,0.15);color:#94A3B8') + ';">' + _esc(r.status) + '</span>';

    return '<div style="border:1px solid rgba(255,255,255,0.06);border-left:3px solid #D4A853;border-radius:6px;padding:10px 12px;margin-bottom:8px;background:rgba(15,23,42,0.5);">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;color:#F1F5F9;">' + _esc(firm) + offPanelBadge + statusPill + '</div>' +
          '<div style="font-size:11px;color:#94A3B8;margin-top:2px;">' +
            (r.rics_member_name ? _esc(r.rics_member_name) + (r.rics_member_number ? ' (' + _esc(r.rics_member_number) + ')' : '') + ' · ' : '') +
            (r.valuation_method ? _esc(r.valuation_method.replace(/_/g, ' ')) : '—') +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' + expPill + actions + '</div>' +
      '</div>' +
      '<div style="margin-top:8px;display:grid;grid-template-columns:repeat(4,1fr);gap:6px 12px;font-size:11px;">' +
        _kv('Lending value', '<strong style="color:#34D399;">' + _money(r.lending_value_pence) + '</strong>') +
        _kv('Market value', _money(r.market_value_pence)) +
        _kv('VP value', _money(r.vp_value_pence)) +
        _kv('MLV', _money(r.mortgage_lending_value_pence)) +
        _kv('Val date', _date(r.valuation_date)) +
        _kv('Inspection', _date(r.inspection_date)) +
        _kv('Comparables', r.comparable_count == null ? '—' : String(r.comparable_count)) +
        _kv('Condition', r.condition_grade || '—') +
      '</div>' +
      ((r.key_risks && r.key_risks.length) ? '<div style="margin-top:6px;font-size:11px;"><span style="color:#94A3B8;">Key risks:</span> ' +
        r.key_risks.map(k => '<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:10px;background:rgba(248,113,113,0.1);color:#F87171;margin:0 3px 3px 0;">' + _esc(k) + '</span>').join('') +
      '</div>' : '') +
      (r.underwriter_commentary ? '<div style="margin-top:6px;padding:6px 8px;background:rgba(78,161,255,0.05);border-left:2px solid #4EA1FF;border-radius:3px;font-size:11px;color:#CBD5E1;line-height:1.5;"><div style="font-size:9px;color:#4EA1FF;text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:2px;">Underwriter commentary</div>' + _esc(r.underwriter_commentary) + '</div>' : '') +
      '<div style="margin-top:6px;font-size:10px;color:#64748B;">' + docLink + '</div>' +
    '</div>';
  }

  function _kv(label, val) {
    return '<div><span style="color:#64748B;font-size:9px;text-transform:uppercase;letter-spacing:.04em;display:block;">' + label + '</span><span style="color:#F1F5F9;">' + val + '</span></div>';
  }

  // ════════════════════════════════════════════════════════════
  // MODAL — add / edit / supersede share the same form
  // ════════════════════════════════════════════════════════════

  let _modalCtx = null; // { mode: 'add'|'edit'|'supersede', dealId, propertyId, valuationId? }
  let _schema = null;
  let _valuersList = [];

  async function _ensureSchemaAndValuers() {
    if (!_schema) {
      const j = await _api('/api/admin/valuations/schema');
      _schema = j.data || {};
    }
    // refresh valuers each open (panel may have just been edited)
    const j2 = await _api('/api/admin/panels/valuers?status=active');
    _valuersList = j2.data || [];
  }

  function _ensureModalDom() {
    if (document.getElementById('val-modal-overlay')) return;
    const div = document.createElement('div');
    div.innerHTML =
      '<div id="val-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:200;align-items:center;justify-content:center;">' +
        '<div style="background:#151a21;border:1px solid #2a3340;border-radius:8px;width:92%;max-width:880px;max-height:92vh;overflow-y:auto;color:#e7ecf3;">' +
          '<div style="padding:14px 18px;border-bottom:1px solid #2a3340;background:#1c232c;display:flex;justify-content:space-between;align-items:center;">' +
            '<h2 id="val-modal-title" style="margin:0;font-size:15px;font-weight:600;">RICS Valuation</h2>' +
            '<button id="val-modal-close" style="background:transparent;color:#8a95a5;border:none;font-size:20px;cursor:pointer;">×</button>' +
          '</div>' +
          '<div id="val-modal-body" style="padding:18px;"></div>' +
          '<div style="padding:12px 18px;border-top:1px solid #2a3340;display:flex;justify-content:flex-end;gap:8px;">' +
            '<button id="val-modal-cancel" style="background:transparent;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:7px 14px;font-size:12px;font-weight:500;cursor:pointer;">Cancel</button>' +
            '<button id="val-modal-save" style="background:#4ea1ff;color:white;border:none;border-radius:4px;padding:7px 14px;font-size:12px;font-weight:500;cursor:pointer;">Save Draft</button>' +
            '<button id="val-modal-save-finalise" style="background:#3ecf8e;color:white;border:none;border-radius:4px;padding:7px 14px;font-size:12px;font-weight:500;cursor:pointer;">Save &amp; Finalise</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div.firstElementChild);
    document.getElementById('val-modal-close').onclick = _closeModal;
    document.getElementById('val-modal-cancel').onclick = _closeModal;
    document.getElementById('val-modal-save').onclick = function () { _saveFromModal(false); };
    document.getElementById('val-modal-save-finalise').onclick = function () { _saveFromModal(true); };
  }

  function _closeModal() {
    const ov = document.getElementById('val-modal-overlay');
    if (ov) ov.style.display = 'none';
    _modalCtx = null;
  }

  function _showModal(title) {
    document.getElementById('val-modal-title').textContent = title;
    document.getElementById('val-modal-overlay').style.display = 'flex';
  }

  function _renderModalBody(values) {
    values = values || {};
    const methods = (_schema && _schema.valid_methods) || [];
    const conds = (_schema && _schema.valid_condition) || [];
    const mkts = (_schema && _schema.valid_marketability) || [];
    const risks = (_schema && _schema.common_key_risks) || [];

    const valuerOpts = _valuersList.map(v =>
      '<option value="' + v.id + '"' + (values.valuer_id == v.id ? ' selected' : '') + '>' + _esc(v.firm_name) +
      (v.rics_firm_number ? ' · ' + _esc(v.rics_firm_number) : '') +
      '</option>'
    ).join('');
    const offPanelChecked = !values.valuer_id && !!values.valuer_off_panel_name;

    const opt = (arr, v) => arr.map(o => '<option value="' + o + '"' + (v === o ? ' selected' : '') + '>' + o.replace(/_/g, ' ') + '</option>').join('');

    const checkedRisks = new Set(values.key_risks || []);
    const risksGrid = risks.map(k =>
      '<label style="display:inline-flex;gap:4px;align-items:center;font-size:11px;margin:0 8px 4px 0;cursor:pointer;">' +
        '<input type="checkbox" data-risk="' + k + '"' + (checkedRisks.has(k) ? ' checked' : '') + ' style="accent-color:#4ea1ff;">' +
        k.replace(/_/g, ' ') +
      '</label>'
    ).join('');

    // Money values come back as pence — display in £ for entry
    const penceToPounds = (p) => p == null ? '' : String(Number(p) / 100);

    const html =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;">' +
        '<div style="grid-column:span 2;font-size:11px;color:#4ea1ff;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a3340;padding-bottom:4px;">Valuer</div>' +
        _formRow('valuer_id', 'Panel valuer (RICS firm)',
          '<select id="vf-valuer_id" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;">' +
            '<option value="">— select —</option>' + valuerOpts +
          '</select>', 2) +
        _formRow('off_panel_check', '',
          '<label style="display:inline-flex;gap:6px;align-items:center;font-size:12px;cursor:pointer;">' +
            '<input type="checkbox" id="vf-off-panel-toggle"' + (offPanelChecked ? ' checked' : '') + ' style="accent-color:#4ea1ff;">' +
            'Use off-panel valuer (free-text — IA grade penalty applies)' +
          '</label>', 2) +
        _formRow('valuer_off_panel_name', 'Off-panel firm name',
          '<input type="text" id="vf-valuer_off_panel_name" value="' + _esc(values.valuer_off_panel_name || '') + '" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">', 2) +
        _formRow('rics_member_name', 'RICS member name',
          '<input type="text" id="vf-rics_member_name" value="' + _esc(values.rics_member_name || '') + '" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +
        _formRow('rics_member_number', 'RICS member number',
          '<input type="text" id="vf-rics_member_number" value="' + _esc(values.rics_member_number || '') + '" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +

        '<div style="grid-column:span 2;font-size:11px;color:#4ea1ff;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a3340;padding-bottom:4px;margin-top:8px;">Method &amp; Dates</div>' +
        _formRow('valuation_method', 'Valuation method',
          '<select id="vf-valuation_method" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;">' +
            '<option value="">— select —</option>' + opt(methods, values.valuation_method) +
          '</select>') +
        _formRow('valuation_date', 'Valuation date',
          '<input type="date" id="vf-valuation_date" value="' + (values.valuation_date ? String(values.valuation_date).substring(0,10) : '') + '" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +
        _formRow('inspection_date', 'Inspection date',
          '<input type="date" id="vf-inspection_date" value="' + (values.inspection_date ? String(values.inspection_date).substring(0,10) : '') + '" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +
        _formRow('comparable_count', 'Comparable count',
          '<input type="number" id="vf-comparable_count" value="' + (values.comparable_count == null ? '' : values.comparable_count) + '" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +

        '<div style="grid-column:span 2;font-size:11px;color:#4ea1ff;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a3340;padding-bottom:4px;margin-top:8px;">Values (£)</div>' +
        _formRow('lending_value', 'Lending value (£) *',
          '<input type="number" id="vf-lending_value" value="' + penceToPounds(values.lending_value_pence) + '" step="1000" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +
        _formRow('market_value', 'Market value (£)',
          '<input type="number" id="vf-market_value" value="' + penceToPounds(values.market_value_pence) + '" step="1000" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +
        _formRow('vp_value', 'VP value (£)',
          '<input type="number" id="vf-vp_value" value="' + penceToPounds(values.vp_value_pence) + '" step="1000" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +
        _formRow('mortgage_lending_value', 'MLV (£)',
          '<input type="number" id="vf-mortgage_lending_value" value="' + penceToPounds(values.mortgage_lending_value_pence) + '" step="1000" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;">') +

        '<div style="grid-column:span 2;font-size:11px;color:#4ea1ff;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a3340;padding-bottom:4px;margin-top:8px;">Qualitative</div>' +
        _formRow('condition_grade', 'Condition',
          '<select id="vf-condition_grade" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;">' +
            '<option value="">— select —</option>' + opt(conds, values.condition_grade) +
          '</select>') +
        _formRow('marketability_grade', 'Marketability',
          '<select id="vf-marketability_grade" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;">' +
            '<option value="">— select —</option>' + opt(mkts, values.marketability_grade) +
          '</select>') +
        _formRow('key_risks', 'Key risks',
          '<div id="vf-key_risks" style="border:1px solid #2a3340;border-radius:4px;padding:8px;background:#0b0e13;">' + risksGrid + '</div>', 2) +
        _formRow('assumptions', 'Assumptions',
          '<textarea id="vf-assumptions" rows="2" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;font-family:inherit;">' + _esc(values.assumptions || '') + '</textarea>', 2) +
        _formRow('recommendations', 'Recommendations',
          '<textarea id="vf-recommendations" rows="2" style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;font-family:inherit;">' + _esc(values.recommendations || '') + '</textarea>', 2) +
        _formRow('underwriter_commentary', 'Underwriter commentary',
          '<textarea id="vf-underwriter_commentary" rows="3" placeholder="What the rubric reads — concise summary of value, comps, risks, why this lending value." style="width:100%;background:#0b0e13;color:#e7ecf3;border:1px solid #2a3340;border-radius:4px;padding:6px 10px;font-size:13px;font-family:inherit;">' + _esc(values.underwriter_commentary || '') + '</textarea>', 2) +

        '<div style="grid-column:span 2;font-size:11px;color:#4ea1ff;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a3340;padding-bottom:4px;margin-top:8px;">PDF (required to finalise)</div>' +
        '<div id="vf-doc-area" style="grid-column:span 2;">' + _docArea(values) + '</div>' +
      '</div>';

    document.getElementById('val-modal-body').innerHTML = html;

    // Wire off-panel toggle: clears valuer_id when checked, shows free-text
    const toggle = document.getElementById('vf-off-panel-toggle');
    const offText = document.getElementById('vf-valuer_off_panel_name');
    const valuerSel = document.getElementById('vf-valuer_id');
    function syncToggle() {
      const off = toggle.checked;
      offText.disabled = !off;
      offText.style.opacity = off ? '1' : '0.4';
      valuerSel.disabled = off;
      valuerSel.style.opacity = off ? '0.4' : '1';
      if (off) valuerSel.value = '';
    }
    toggle.addEventListener('change', syncToggle);
    syncToggle();
    valuerSel.addEventListener('change', () => {
      if (valuerSel.value) {
        toggle.checked = false;
        syncToggle();
        offText.value = '';
      }
    });
  }

  function _formRow(name, label, inputHtml, span) {
    return '<div' + (span === 2 ? ' style="grid-column:span 2;"' : '') + '>' +
      (label ? '<label style="display:block;font-size:10px;color:#8a95a5;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">' + label + '</label>' : '') +
      inputHtml +
    '</div>';
  }

  function _docArea(values) {
    // Always show file picker — saving handles upload+attach+save in one round-trip.
    // If a doc is already attached, show that status alongside an option to replace.
    const attached = values && values.document_id;
    const attachedNote = attached
      ? '<div style="font-size:11px;color:#34D399;margin-bottom:6px;">✓ Currently attached: document #' + values.document_id + '. Picking a new file will replace it on save.</div>'
      : '';
    return attachedNote +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        '<input type="file" id="vf-doc-file" accept="application/pdf,.pdf" style="font-size:12px;color:#e7ecf3;">' +
        '<span id="vf-doc-status" style="font-size:11px;color:#8a95a5;">' +
          (attached ? '' : 'Pick the RICS PDF — it will upload when you click Save.') +
        '</span>' +
      '</div>';
  }

  // Read form into payload
  function _readForm() {
    const out = {};
    const v = (id) => { const el = document.getElementById('vf-' + id); return el ? el.value : ''; };

    const offPanel = document.getElementById('vf-off-panel-toggle').checked;
    if (offPanel) {
      out.valuer_id = null;
      out.valuer_off_panel_name = v('valuer_off_panel_name').trim() || null;
    } else {
      const vid = v('valuer_id');
      out.valuer_id = vid ? Number(vid) : null;
      out.valuer_off_panel_name = null;
    }
    out.rics_member_name = v('rics_member_name').trim() || null;
    out.rics_member_number = v('rics_member_number').trim() || null;
    out.valuation_method = v('valuation_method') || null;
    out.valuation_date = v('valuation_date') || null;
    out.inspection_date = v('inspection_date') || null;
    out.comparable_count = v('comparable_count') === '' ? null : Number(v('comparable_count'));

    const poundsToPence = (s) => s === '' ? null : Math.round(Number(s) * 100);
    out.lending_value_pence = poundsToPence(v('lending_value'));
    out.market_value_pence = poundsToPence(v('market_value'));
    out.vp_value_pence = poundsToPence(v('vp_value'));
    out.mortgage_lending_value_pence = poundsToPence(v('mortgage_lending_value'));

    out.condition_grade = v('condition_grade') || null;
    out.marketability_grade = v('marketability_grade') || null;

    const risks = [];
    document.querySelectorAll('#vf-key_risks input[type="checkbox"][data-risk]').forEach(cb => {
      if (cb.checked) risks.push(cb.dataset.risk);
    });
    out.key_risks = risks.length ? risks : null;

    out.assumptions = v('assumptions').trim() || null;
    out.recommendations = v('recommendations').trim() || null;
    out.underwriter_commentary = v('underwriter_commentary').trim() || null;
    return out;
  }

  // ════════════════════════════════════════════════════════════
  // ACTIONS
  // ════════════════════════════════════════════════════════════

  window._valOpenAdd = async function (propertyId, dealId) {
    try {
      _ensureModalDom();
      await _ensureSchemaAndValuers();
      _modalCtx = { mode: 'add', dealId, propertyId, valuationId: null };
      _renderModalBody({ property_id: propertyId });
      _showModal('Add RICS Valuation');
    } catch (err) {
      alert('Could not open form: ' + err.message);
    }
  };

  window._valOpenEdit = async function (valuationId) {
    try {
      _ensureModalDom();
      await _ensureSchemaAndValuers();
      const j = await _api('/api/admin/valuations/single/' + valuationId);
      const row = j.data;
      _modalCtx = { mode: 'edit', dealId: row.deal_id, propertyId: row.property_id, valuationId };
      _renderModalBody(row);
      _showModal('Edit Draft Valuation');
    } catch (err) {
      alert('Could not load valuation: ' + err.message);
    }
  };

  window._valOpenSupersede = async function (valuationId, dealId) {
    try {
      _ensureModalDom();
      await _ensureSchemaAndValuers();
      const j = await _api('/api/admin/valuations/single/' + valuationId);
      const row = j.data;
      _modalCtx = { mode: 'supersede', dealId, propertyId: row.property_id, valuationId };
      // Pre-fill with existing data — underwriter usually changes only date + lending value
      _renderModalBody(Object.assign({}, row, { document_id: null }));
      _showModal('Re-val (supersedes #' + valuationId + ')');
    } catch (err) {
      alert('Could not load original valuation: ' + err.message);
    }
  };

  // Unified save handler — handles draft AND finalise in one button-press flow.
  //   1. Read form
  //   2. If a PDF is picked, upload it first → get document_id
  //   3. Save (POST/PUT/supersede) the valuation with document_id attached
  //   4. If alsoFinalise=true, call /finalise
  //   5. Close modal, toast, refresh panel
  async function _saveFromModal(alsoFinalise) {
    console.log('[val-save] click — alsoFinalise=', alsoFinalise, 'ctx=', _modalCtx);
    if (!_modalCtx) {
      alert('Cannot save — modal context lost. Close and re-open the form.');
      return;
    }
    const btnDraft = document.getElementById('val-modal-save');
    const btnFin = document.getElementById('val-modal-save-finalise');
    btnDraft.disabled = true;
    btnFin.disabled = true;
    const activeBtn = alsoFinalise ? btnFin : btnDraft;
    const origText = activeBtn.textContent;
    activeBtn.textContent = 'Saving…';

    const statusEl = document.getElementById('vf-doc-status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

    try {
      const data = _readForm();
      console.log('[val-save] payload=', data);

      // STEP 1 — Upload PDF if a fresh file is picked. We get back a
      // document_id and bake it into the save payload BEFORE writing the
      // valuation row, so finalise can succeed in the same round-trip.
      const fileInput = document.getElementById('vf-doc-file');
      const hasNewFile = fileInput && fileInput.files && fileInput.files[0];
      if (hasNewFile) {
        setStatus('Uploading PDF…');
        const submissionId =
          (_modalCtx && _modalCtx.dealSubmissionId) ||
          (window.currentDeal && window.currentDeal.submission_id);
        if (!submissionId) throw new Error('Could not resolve deal submission_id for upload');
        const fd = new FormData();
        fd.append('file', fileInput.files[0]);
        const r = await fetch(_apiBase() + '/api/admin/deals/' + submissionId + '/upload', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + _token() },
          body: fd
        });
        const j = await r.json();
        if (!r.ok || !j.success) throw new Error((j && j.error) || ('Upload failed (HTTP ' + r.status + ')'));
        const docId = j.documents && j.documents[0] && j.documents[0].id;
        if (!docId) throw new Error('Upload succeeded but no document_id returned');
        data.document_id = docId;
        setStatus('✓ PDF uploaded (doc ' + docId + ')');
      } else if (alsoFinalise && (!_modalCtx.valuationId || !_modalCtx.hasDoc)) {
        // Trying to finalise without a PDF and none on file — fail fast with a friendly message.
        // (We allow finalise without picking a fresh file IF the existing draft already has a doc.)
        const existing = _modalCtx.valuationId
          ? await _api('/api/admin/valuations/single/' + _modalCtx.valuationId).catch(() => null)
          : null;
        if (!existing || !existing.data || !existing.data.document_id) {
          throw new Error('Cannot finalise without a RICS PDF attached. Pick a PDF and click Save & Finalise again.');
        }
      }

      // STEP 2 — Save (create / update / supersede)
      let valuationId = _modalCtx.valuationId;
      let savedAction = '';
      if (_modalCtx.mode === 'add') {
        data.property_id = _modalCtx.propertyId;
        const j = await _api('/api/admin/valuations/' + _modalCtx.dealId, {
          method: 'POST', body: JSON.stringify(data)
        });
        valuationId = j.data.id;
        savedAction = 'Draft created (id ' + valuationId + ')';
      } else if (_modalCtx.mode === 'edit') {
        await _api('/api/admin/valuations/' + valuationId, {
          method: 'PUT', body: JSON.stringify(data)
        });
        savedAction = 'Draft updated (id ' + valuationId + ')';
      } else if (_modalCtx.mode === 'supersede') {
        data.property_id = _modalCtx.propertyId;
        const j = await _api('/api/admin/valuations/' + valuationId + '/supersede', {
          method: 'POST', body: JSON.stringify(data)
        });
        valuationId = j.data.newRow.id;
        savedAction = 'New draft (id ' + valuationId + ') — old valuation superseded';
      }

      // STEP 3 — Finalise if requested
      if (alsoFinalise) {
        setStatus('Finalising…');
        await _api('/api/admin/valuations/' + valuationId + '/finalise', { method: 'POST' });
        savedAction += ' · finalised — lending value is now the LTV anchor';
      }

      console.log('[val-save] success —', savedAction);
      const propIdForRefresh = _modalCtx.propertyId;
      const dealIdForRefresh = _modalCtx.dealId;
      _closeModal();
      // Auto-expand the panel so the new/updated row is visible
      const body = document.getElementById('val-body-' + propIdForRefresh);
      const chev = document.getElementById('val-chev-' + propIdForRefresh);
      if (body && body.style.display === 'none') {
        body.style.display = 'block';
        if (chev) chev.style.transform = 'rotate(90deg)';
      }
      _refreshPanel(propIdForRefresh, dealIdForRefresh);
      _toast('✓ ' + savedAction, 'success');
    } catch (err) {
      console.error('[val-save] failed:', err);
      _toast('Save failed: ' + err.message, 'error');
      btnDraft.disabled = false;
      btnFin.disabled = false;
      activeBtn.textContent = origText;
    }
  }

  window._valUploadDoc = async function (valuationId) {
    const fileInput = document.getElementById('vf-doc-file');
    const status = document.getElementById('vf-doc-status');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      alert('Pick a PDF file first.');
      return;
    }
    if (!_modalCtx || !_modalCtx.dealId) return;

    // Look up deal submission_id from current dealId — fetch if not cached
    let submissionId = _modalCtx.dealSubmissionId;
    if (!submissionId) {
      try {
        const j = await _api('/api/admin/valuations/single/' + valuationId);
        submissionId = j.data && j.data.submission_id;
      } catch (_) {}
    }
    if (!submissionId) {
      // Fallback: use the deal page's deal object, exposed by deal-detail.js if available
      const sid = (window.currentDeal && window.currentDeal.submission_id) || null;
      submissionId = sid;
    }
    if (!submissionId) {
      alert('Could not resolve deal submission_id for upload. Reload the page and retry.');
      return;
    }

    try {
      status.textContent = 'Uploading…';
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      const r = await fetch(_apiBase() + '/api/admin/deals/' + submissionId + '/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + _token() },
        body: fd
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j.error || 'Upload failed');
      const docId = j.documents && j.documents[0] && j.documents[0].id;
      if (!docId) throw new Error('Upload succeeded but no document id returned');
      status.textContent = 'Attaching…';
      await _api('/api/admin/valuations/' + valuationId + '/attach-document', {
        method: 'POST', body: JSON.stringify({ document_id: docId })
      });
      status.textContent = '✓ Attached (doc ' + docId + ')';
      _toast('✓ PDF attached to draft. You can now Finalise this valuation.', 'success');
      _refreshPanel(_modalCtx.propertyId, _modalCtx.dealId);
    } catch (err) {
      status.textContent = '';
      alert('Upload failed: ' + err.message);
    }
  };

  window._valFinalise = async function (valuationId, dealId) {
    if (!confirm('Finalise this valuation? Lending value becomes the LTV anchor for the rubric. Edits after finalisation require a Re-val (supersede).')) return;
    try {
      await _api('/api/admin/valuations/' + valuationId + '/finalise', { method: 'POST' });
      // Refresh the panel — find which property this val is on
      const r = await _api('/api/admin/valuations/single/' + valuationId);
      _refreshPanel(r.data.property_id, dealId);
      _toast('✓ Valuation finalised — lending value is now the LTV anchor for the rubric.', 'success');
    } catch (err) {
      _toast('Finalise failed: ' + err.message, 'error');
    }
  };

  async function _refreshPanel(propertyId, dealId) {
    // Always fetch — even if collapsed — so the status pill in the header
    // is up to date. The body content stays hidden until expanded.
    try {
      const j = await _api('/api/admin/valuations/property/' + propertyId + '/' + dealId);
      _renderRows(propertyId, dealId, j.data || []);
    } catch (err) {
      console.error('[valuations-panel] refresh failed:', err);
    }
  }

  // Auto-load status pills for all property panels on the page so the
  // header shows ✓ Finalised / ● Draft / — No valuation without the user
  // having to expand each one.
  async function _autoloadPills() {
    if (!window.currentDeal || !window.currentDeal.id) return;
    const dealId = window.currentDeal.id;
    const props = (window.currentDeal.properties || []).map(p => p.id).filter(Boolean);
    for (const propId of props) {
      _refreshPanel(propId, dealId);
    }
  }
  // Defer until DOM has rendered the property cards
  setTimeout(_autoloadPills, 1500);

  console.log('[valuations-panel] Loaded — window._buildValuationsPanel available');
})();
