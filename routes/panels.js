/**
 * routes/panels.js — Approved valuer + lawyer panel admin endpoints
 * ============================================================
 * Admin-only CRUD on the two reference tables `approved_valuers`
 * and `approved_lawyers`. Used by /admin/panels.html and consumed
 * by deal-matrix valuer/lawyer dropdowns.
 *
 * Sumit's directives (2026-04-28):
 *   • Single admin model — no 4-eyes rule
 *   • Soft-delete only (status enum: active|suspended|removed)
 *   • CSV bulk import for initial seed
 *   • approved_by_funder filter so admin can show "GB Bank panel only"
 *
 * MOUNT: app.use('/api/admin/panels', panelsRouter);
 *   → /api/admin/panels/valuers              GET   list
 *   → /api/admin/panels/valuers/:id          GET   one
 *   → /api/admin/panels/valuers              POST  create
 *   → /api/admin/panels/valuers/:id          PUT   update
 *   → /api/admin/panels/valuers/:id/suspend  POST  soft-suspend
 *   → /api/admin/panels/valuers/:id/remove   POST  soft-remove
 *   → /api/admin/panels/valuers/:id/restore  POST  reactivate
 *   → /api/admin/panels/valuers/import       POST  CSV bulk import
 *   (and the mirrored 8 endpoints under /lawyers)
 * ============================================================
 */

const express = require('express');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');
const panels = require('../services/panels');

const router = express.Router();

// All routes require admin
router.use(authenticateToken);
router.use(authenticateAdmin);

// ============================================================
// Helpers
// ============================================================

/**
 * Normalises query params for list filters.
 * Accepts ?funder=daksfirst&status=active&search=knight
 * Status defaults to 'active'; pass status=* for all.
 */
function parseListOpts(req) {
  return {
    funder: req.query.funder || null,
    status: req.query.status || 'active',
    search: req.query.search || null
  };
}

/**
 * Generic error wrapper — keeps response shape consistent.
 */
function wrapErr(res, err, fallback = 'Internal error') {
  console.error('[panels]', err);
  const message = err && err.message ? err.message : fallback;
  // Validation errors (firm_name required etc.) → 400; everything else 500
  const status = /required|invalid|must be/i.test(message) ? 400 : 500;
  res.status(status).json({ success: false, error: message });
}

// ============================================================
// Factory: build a sub-router for a panel type
// ============================================================
function buildPanelSubrouter(typeName, api) {
  const sub = express.Router();

  // GET / — list with optional filters
  sub.get('/', async (req, res) => {
    try {
      const rows = await api.list(parseListOpts(req));
      res.json({ success: true, data: rows, count: rows.length });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // GET /:id — single firm
  sub.get('/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
      const row = await api.getById(id);
      if (!row) return res.status(404).json({ success: false, error: `${typeName} not found` });
      res.json({ success: true, data: row });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // POST / — create new firm
  sub.post('/', async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      const row = await api.create(req.body || {}, userId);
      res.status(201).json({ success: true, data: row });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // PUT /:id — update fields (NOT status — status changes via suspend/remove/restore)
  sub.put('/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
      const userId = req.user && req.user.id;
      const row = await api.update(id, req.body || {}, userId);
      if (!row) return res.status(404).json({ success: false, error: `${typeName} not found` });
      res.json({ success: true, data: row });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // POST /:id/suspend — soft-suspend (reversible)
  sub.post('/:id/suspend', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
      const userId = req.user && req.user.id;
      const reason = (req.body && req.body.reason) || null;
      const row = await api.suspend(id, userId, reason);
      if (!row) return res.status(404).json({ success: false, error: `${typeName} not found` });
      res.json({ success: true, data: row });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // POST /:id/remove — soft-remove (reversible; records audit trail)
  sub.post('/:id/remove', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
      const userId = req.user && req.user.id;
      const reason = (req.body && req.body.reason) || null;
      const row = await api.remove(id, userId, reason);
      if (!row) return res.status(404).json({ success: false, error: `${typeName} not found` });
      res.json({ success: true, data: row });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // POST /:id/restore — reactivate suspended/removed firm
  sub.post('/:id/restore', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
      const userId = req.user && req.user.id;
      const row = await api.restore(id, userId);
      if (!row) return res.status(404).json({ success: false, error: `${typeName} not found` });
      res.json({ success: true, data: row });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  // POST /import — CSV bulk import (body: { rows: [...] })
  sub.post('/import', async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
      if (!rows) {
        return res.status(400).json({
          success: false,
          error: 'Body must be { rows: [array of firm objects] }'
        });
      }
      const result = await api.importCsv(rows, userId);
      res.json({ success: true, data: result });
    } catch (err) {
      wrapErr(res, err);
    }
  });

  return sub;
}

// ============================================================
// Mount sub-routers
// ============================================================

router.use('/valuers', buildPanelSubrouter('Valuer', {
  list:     panels.listValuers,
  getById:  panels.getValuer,
  create:   panels.createValuer,
  update:   panels.updateValuer,
  suspend:  panels.suspendValuer,
  remove:   panels.removeValuer,
  restore:  panels.restoreValuer,
  importCsv: panels.importValuersCsv
}));

router.use('/lawyers', buildPanelSubrouter('Lawyer', {
  list:     panels.listLawyers,
  getById:  panels.getLawyer,
  create:   panels.createLawyer,
  update:   panels.updateLawyer,
  suspend:  panels.suspendLawyer,
  remove:   panels.removeLawyer,
  restore:  panels.restoreLawyer,
  importCsv: panels.importLawyersCsv
}));

// ============================================================
// Schema endpoint — surfaces VALUER_COLUMNS / LAWYER_COLUMNS
// so admin UI can render forms without hard-coding column names.
// ============================================================
router.get('/schema', (req, res) => {
  res.json({
    success: true,
    data: {
      valuer_columns: panels.VALUER_COLUMNS,
      lawyer_columns: panels.LAWYER_COLUMNS,
      status_values: ['active', 'suspended', 'removed'],
      common_funders: ['daksfirst', 'gb_bank', 'starling_warehouse']
    }
  });
});

module.exports = router;
