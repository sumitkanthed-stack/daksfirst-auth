/**
 * admin/_guard.js — client-side admin-page guard
 *
 * Loaded as the very first <script> in every admin/*.html. Decodes session
 * from sessionStorage and bounces users whose role isn't in the page's
 * allowlist before any chrome paints.
 *
 * NOT a security boundary. Every admin API endpoint is requireRoles(...)
 * server-side. This guard prevents accidental URL discovery from rendering
 * an admin shell that looks "real" to a user without the data behind it.
 */
(function () {
  'use strict';

  // Per-page role allowlist. Defaults to admin-only if page not listed.
  var PAGE_ROLES = {
    'pricing.html':         ['admin', 'rm', 'credit'],
    'pricing-grid.html':    ['admin', 'rm', 'credit'],
    'rate-card.html':       ['admin', 'rm', 'credit'],
    'models.html':          ['admin'],
    'panels.html':          ['admin'],
    'broker-activity.html': ['admin']
  };
  var REDIRECT_TO = '/';

  function deny() {
    try { document.documentElement.style.display = 'none'; } catch (e) {}
    window.location.replace(REDIRECT_TO);
  }

  function pageName() {
    var p = (window.location.pathname || '').split('/').pop() || '';
    return p.toLowerCase();
  }

  try {
    var page    = pageName();
    var allowed = PAGE_ROLES[page] || ['admin'];
    var token   = sessionStorage.getItem('daksfirst_token');
    var userS   = sessionStorage.getItem('daksfirst_user');
    if (!token || !userS) return deny();

    var user;
    try { user = JSON.parse(userS); } catch (e) { return deny(); }
    if (!user || !allowed.includes(user.role)) return deny();

    var parts = token.split('.');
    if (parts.length !== 3) return deny();
    var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var payload;
    try { payload = JSON.parse(atob(b64)); } catch (e) { return deny(); }

    if (!allowed.includes(payload.role)) return deny();
    if (payload.exp && payload.exp * 1000 < Date.now()) return deny();
    // ✓ allowed role with non-expired token
  } catch (err) {
    console.error('[admin-guard] check failed:', err);
    deny();
  }
})();