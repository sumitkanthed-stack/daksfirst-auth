/**
 * admin/_guard.js — client-side admin-page guard
 *
 * Loaded as the very first <script> in every admin/*.html. Runs synchronously
 * before any page chrome, checks sessionStorage for a daksfirst session, and
 * bounces non-admin users to the dashboard root before the admin shell paints.
 *
 * NOT a security boundary. The actual security is at the API layer — every
 * admin endpoint is requireRoles(['admin']) (Chunks A+B+E onwards). A
 * determined attacker can edit sessionStorage and bypass this guard, but
 * every API call they trigger from the admin shell will 403.
 *
 * Purpose is UX: stop accidental URL discovery from rendering an admin
 * shell that looks "real" to a non-admin user.
 *
 * Future: replace with server-side gate when admin pages move from Vercel
 * static onto Express (Path B in CONTINUITY.md).
 */
(function () {
  'use strict';

  var ALLOWED_ROLE = 'admin';
  var REDIRECT_TO  = '/';

  function deny() {
    // Hide the documentElement first so no admin chrome can flash before the
    // navigation completes. Then replace the URL.
    try { document.documentElement.style.display = 'none'; } catch (e) {}
    window.location.replace(REDIRECT_TO);
  }

  try {
    var token  = sessionStorage.getItem('daksfirst_token');
    var userS  = sessionStorage.getItem('daksfirst_user');
    if (!token || !userS) return deny();

    var user;
    try { user = JSON.parse(userS); } catch (e) { return deny(); }
    if (!user || user.role !== ALLOWED_ROLE) return deny();

    // Cross-check via JWT payload — defends against a user-object that's
    // been edited locally without matching token.
    var parts = token.split('.');
    if (parts.length !== 3) return deny();
    var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var payload;
    try { payload = JSON.parse(atob(b64)); } catch (e) { return deny(); }

    if (payload.role !== ALLOWED_ROLE) return deny();
    if (payload.exp && payload.exp * 1000 < Date.now()) return deny();

    // ✓ admin with non-expired token — let the page render
  } catch (err) {
    console.error('[admin-guard] check failed:', err);
    deny();
  }
})();