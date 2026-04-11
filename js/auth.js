import { API_BASE } from './config.js';
import { showAlert, hideAlert, showScreen, showToast } from './utils.js';
import {
  setAuthToken, setRefreshToken, setCurrentUser, setCurrentRole, getAuthToken, getRefreshToken,
  restoreSessionFromStorage, clearSession, getCurrentUser, getCurrentRole
} from './state.js';

// Re-export state getters so other modules can import them from auth.js
export { getAuthToken, getCurrentUser, getCurrentRole } from './state.js';

// ═══════════════════════════════════════════════════════════════════
// SESSION RECOVERY SYSTEM — queue failed requests, re-auth inline, replay
// ═══════════════════════════════════════════════════════════════════
let _requestQueue = [];       // queued { url, options, resolve, reject } while session is expired
let _sessionExpired = false;  // true once refresh fails — blocks further API calls until re-auth
let _reAuthModalShown = false;

/**
 * Fetch wrapper that adds Authorization header, handles token refresh,
 * and queues requests during session recovery instead of losing them.
 */
export async function fetchWithAuth(url, options = {}) {
  // If session is expired and re-auth modal is showing, queue this request
  if (_sessionExpired) {
    return new Promise((resolve, reject) => {
      _requestQueue.push({ url, options, resolve, reject });
      console.log(`[auth] Queued request (${_requestQueue.length}): ${options.method || 'GET'} ${url.substring(url.lastIndexOf('/') - 20)}`);
    });
  }

  const token = getAuthToken();

  if (!options.headers) {
    options.headers = {};
  }

  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  let response = await fetch(url, options);

  // If 401/403, try to refresh token and retry once
  if ((response.status === 401 || response.status === 403) && token) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const newToken = getAuthToken();
      options.headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, options);
    } else {
      // Refresh token also expired — enter session recovery mode
      _sessionExpired = true;
      showReAuthModal();

      // Queue THIS request too so it replays after re-auth
      return new Promise((resolve, reject) => {
        _requestQueue.push({ url, options, resolve, reject });
        console.log(`[auth] Session expired. Queued request (${_requestQueue.length}): ${options.method || 'GET'} ${url.substring(url.lastIndexOf('/') - 20)}`);
      });
    }
  }

  return response;
}

/**
 * Show inline re-authentication modal — no page redirect, no lost state
 */
function showReAuthModal() {
  if (_reAuthModalShown) return;
  _reAuthModalShown = true;

  const user = getCurrentUser();
  const emailHint = user?.email || '';
  const queueCount = _requestQueue.length;

  const overlay = document.createElement('div');
  overlay.id = 'reauth-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

  overlay.innerHTML = `
    <div style="background:#1a2332;border-radius:16px;padding:32px 36px;max-width:420px;width:90%;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-family:inherit;">
      <div style="text-align:center;margin-bottom:20px;">
        <div style="width:56px;height:56px;border-radius:50%;background:rgba(251,191,36,0.1);display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
          <span style="font-size:28px;">&#128274;</span>
        </div>
        <div style="font-size:18px;font-weight:700;color:#F1F5F9;">Session Expired</div>
        <div style="font-size:13px;color:#94A3B8;margin-top:4px;">Your session has timed out. Log in again to continue — your work is saved.</div>
      </div>

      <div id="reauth-queue-info" style="background:rgba(212,168,83,0.15);border:1px solid #D4A853;border-radius:8px;padding:10px 14px;margin-bottom:16px;text-align:center;">
        <span style="font-size:12px;color:#D4A853;font-weight:600;" id="reauth-queue-count">${queueCount > 0 ? `${queueCount} pending save${queueCount > 1 ? 's' : ''} will resume automatically` : 'Your progress is preserved'}</span>
      </div>

      <div id="reauth-error" style="display:none;background:rgba(248,113,113,0.1);border:1px solid #F87171;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#F87171;font-weight:500;"></div>

      <div style="margin-bottom:12px;">
        <label style="font-size:11px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:4px;">Email</label>
        <input id="reauth-email" type="email" value="${emailHint}" style="width:100%;padding:10px 14px;border:1px rgba(255,255,255,0.06);border-radius:8px;font-size:14px;color:#F1F5F9;background:#0f1729;outline:none;box-sizing:border-box;" />
      </div>

      <div style="margin-bottom:20px;">
        <label style="font-size:11px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:4px;">Password</label>
        <input id="reauth-password" type="password" style="width:100%;padding:10px 14px;border:1px rgba(255,255,255,0.06);border-radius:8px;font-size:14px;color:#F1F5F9;background:#0f1729;outline:none;box-sizing:border-box;" placeholder="Enter your password" />
      </div>

      <button id="reauth-submit" style="width:100%;padding:12px;border:none;border-radius:8px;background:#D4A853;color:#111827;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;">
        Log In & Continue
      </button>

      <div id="reauth-progress" style="display:none;text-align:center;margin-top:12px;">
        <div style="font-size:12px;color:#94A3B8;font-weight:600;" id="reauth-progress-text">Replaying saved requests...</div>
        <div style="background:rgba(255,255,255,0.06);border-radius:4px;height:6px;margin-top:8px;overflow:hidden;">
          <div id="reauth-progress-bar" style="width:0%;height:100%;background:#34D399;border-radius:4px;transition:width .3s;"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Focus password field (email likely pre-filled)
  setTimeout(() => {
    const pwField = document.getElementById('reauth-password');
    if (pwField) pwField.focus();
  }, 100);

  // Handle submit
  document.getElementById('reauth-submit').addEventListener('click', handleReAuth);
  document.getElementById('reauth-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleReAuth();
  });
}

/**
 * Handle re-authentication from the modal
 */
async function handleReAuth() {
  const email = document.getElementById('reauth-email')?.value?.trim();
  const password = document.getElementById('reauth-password')?.value;
  const errorEl = document.getElementById('reauth-error');
  const submitBtn = document.getElementById('reauth-submit');

  if (!email || !password) {
    if (errorEl) { errorEl.textContent = 'Please enter your email and password.'; errorEl.style.display = 'block'; }
    return;
  }

  // Disable button while authenticating
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Authenticating...'; }
  if (errorEl) errorEl.style.display = 'none';

  try {
    const resp = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await resp.json();

    if (!resp.ok) {
      if (errorEl) { errorEl.textContent = data.error || 'Login failed. Please check your credentials.'; errorEl.style.display = 'block'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Log In & Continue'; submitBtn.style.background = '#D4A853'; }
      return;
    }

    // Store new credentials
    if (data.token) setAuthToken(data.token);
    if (data.refresh_token) setRefreshToken(data.refresh_token);
    if (data.user) { setCurrentUser(data.user); setCurrentRole(data.user.role); }

    // Session restored — replay queued requests
    _sessionExpired = false;
    if (submitBtn) submitBtn.textContent = 'Authenticated! Resuming...';

    await replayQueuedRequests();

    // Remove modal
    const overlay = document.getElementById('reauth-overlay');
    if (overlay) overlay.remove();
    _reAuthModalShown = false;

    showToast(`Session restored — ${_requestQueue.length === 0 ? 'all saves replayed' : 'ready to continue'}`, 'success');
    _requestQueue = [];

  } catch (err) {
    console.error('[auth] Re-auth failed:', err);
    if (errorEl) { errorEl.textContent = 'Network error. Please check your connection.'; errorEl.style.display = 'block'; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Log In & Continue'; }
  }
}

/**
 * Replay all queued requests with the new token
 */
async function replayQueuedRequests() {
  const queue = [..._requestQueue];
  _requestQueue = [];

  if (queue.length === 0) return;

  const progressEl = document.getElementById('reauth-progress');
  const progressBar = document.getElementById('reauth-progress-bar');
  const progressText = document.getElementById('reauth-progress-text');
  const queueInfo = document.getElementById('reauth-queue-info');

  if (progressEl) progressEl.style.display = 'block';
  if (queueInfo) queueInfo.style.display = 'none';

  let completed = 0;
  let failed = 0;

  for (const req of queue) {
    try {
      // Update auth header with fresh token
      if (!req.options.headers) req.options.headers = {};
      req.options.headers['Authorization'] = `Bearer ${getAuthToken()}`;

      const response = await fetch(req.url, req.options);
      req.resolve(response);
      completed++;
    } catch (err) {
      console.error('[auth] Replay failed:', req.url, err);
      req.reject(err);
      failed++;
    }

    // Update progress
    const pct = Math.round(((completed + failed) / queue.length) * 100);
    if (progressBar) progressBar.style.width = pct + '%';
    if (progressText) progressText.textContent = `Replaying saves... ${completed + failed}/${queue.length}`;
  }

  if (progressText) {
    progressText.textContent = failed > 0
      ? `Done — ${completed} saved, ${failed} failed`
      : `All ${completed} saves completed!`;
    progressText.style.color = failed > 0 ? '#FBBF24' : '#34D399';
  }

  // Brief pause so user sees the completion
  await new Promise(r => setTimeout(r, 800));
}

/**
 * Refresh the access token using the refresh token
 */
export async function refreshAccessToken() {
  const refreshTok = getRefreshToken();
  if (!refreshTok) return false;

  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshTok })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.token) {
        setAuthToken(data.token);
        if (data.refresh_token) {
          setRefreshToken(data.refresh_token);
        }
        return true;
      }
    }
  } catch (err) {
    console.error('Token refresh failed:', err);
  }

  // If refresh failed, don't clear session — let re-auth modal handle it
  return false;
}

/**
 * Register a new user
 */
export async function registerUser(role, formData) {
  const registrationData = {
    role: role,
    email: formData.email,
    password: formData.password,
    first_name: formData.firstName,
    last_name: formData.lastName,
    phone: formData.phone || null,
    company: formData.company || null
  };

  try {
    const resp = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData)
    });

    const data = await resp.json();

    if (!resp.ok) {
      showAlert('reg-alert', 'error', data.error || 'Registration failed');
      return false;
    }

    // On success, store token and user
    if (data.token) {
      setAuthToken(data.token);
    }
    if (data.refresh_token) {
      setRefreshToken(data.refresh_token);
    }
    setCurrentUser(data.user);
    setCurrentRole(data.user.role);

    return true;
  } catch (err) {
    showAlert('reg-alert', 'error', 'Network error: ' + err.message);
    return false;
  }
}

/**
 * Login user
 */
export async function loginUser(email, password) {
  try {
    const resp = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await resp.json();

    if (!resp.ok) {
      showAlert('login-alert', 'error', data.error || 'Login failed');
      return false;
    }

    // Store credentials
    if (data.token) {
      setAuthToken(data.token);
    }
    if (data.refresh_token) {
      setRefreshToken(data.refresh_token);
    }
    setCurrentUser(data.user);
    setCurrentRole(data.user.role);

    return true;
  } catch (err) {
    showAlert('login-alert', 'error', 'Network error: ' + err.message);
    return false;
  }
}

/**
 * Logout user
 */
export function logoutUser() {
  clearSession();
  showScreen('screen-landing');
}

/**
 * Handle email verification link (from ?token=)
 */
export async function handleEmailVerification(token) {
  showScreen('screen-verify');
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      document.getElementById('verify-spinner').textContent = '\u2713';
      document.getElementById('verify-spinner').style.color = '#34D399';
      document.getElementById('verify-title').textContent = 'Email Verified!';
      document.getElementById('verify-message').textContent = 'Your email has been verified successfully. You can now log in to your account.';
    } else {
      document.getElementById('verify-spinner').textContent = '\u2717';
      document.getElementById('verify-spinner').style.color = '#F87171';
      document.getElementById('verify-title').textContent = 'Verification Failed';
      document.getElementById('verify-message').textContent = data.error || 'The verification link is invalid or has expired. Please register again or contact support.';
    }
  } catch (err) {
    document.getElementById('verify-spinner').textContent = '\u2717';
    document.getElementById('verify-spinner').style.color = '#F87171';
    document.getElementById('verify-title').textContent = 'Verification Error';
    document.getElementById('verify-message').textContent = 'Unable to connect to the server. Please try again later.';
  }
  document.getElementById('verify-actions').style.display = 'block';
}

/**
 * Restore session on page load and navigate appropriately
 */
export function initAuthAndRouting() {
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('token');

  if (verifyToken) {
    // Clean the URL
    window.history.replaceState({}, '', window.location.pathname);
    handleEmailVerification(verifyToken);
    return;
  }

  // Check for saved login session
  if (restoreSessionFromStorage()) {
    const currentUser = getCurrentUser();
    const currentRole = getCurrentRole();
    const internalRoles = ['admin', 'rm', 'credit', 'compliance'];

    if (internalRoles.includes(currentRole)) {
      // Lazy import admin module to avoid circular deps
      import('./admin.js').then(m => m.showAdminPanel());
    } else {
      // Lazy import deals module
      import('./deals.js').then(m => m.showDashboard());
    }
  }
}
