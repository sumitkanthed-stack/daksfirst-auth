import { API_BASE } from './config.js';
import { showAlert, hideAlert, showScreen, showToast } from './utils.js';
import {
  setAuthToken, setRefreshToken, setCurrentUser, setCurrentRole, getAuthToken, getRefreshToken,
  restoreSessionFromStorage, clearSession, getCurrentUser, getCurrentRole
} from './state.js';

// Re-export state getters so other modules can import them from auth.js
export { getAuthToken, getCurrentUser, getCurrentRole } from './state.js';

/**
 * Fetch wrapper that adds Authorization header and handles token refresh
 */
export async function fetchWithAuth(url, options = {}) {
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
    }
  }

  return response;
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

  // If refresh failed, clear session
  clearSession();
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
      document.getElementById('verify-spinner').style.color = '#48bb78';
      document.getElementById('verify-title').textContent = 'Email Verified!';
      document.getElementById('verify-message').textContent = 'Your email has been verified successfully. You can now log in to your account.';
    } else {
      document.getElementById('verify-spinner').textContent = '\u2717';
      document.getElementById('verify-spinner').style.color = '#e53e3e';
      document.getElementById('verify-title').textContent = 'Verification Failed';
      document.getElementById('verify-message').textContent = data.error || 'The verification link is invalid or has expired. Please register again or contact support.';
    }
  } catch (err) {
    document.getElementById('verify-spinner').textContent = '\u2717';
    document.getElementById('verify-spinner').style.color = '#e53e3e';
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
