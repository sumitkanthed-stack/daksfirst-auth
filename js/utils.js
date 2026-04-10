/**
 * Sanitize HTML entities to prevent XSS attacks
 * Escapes &, <, >, ", ' characters
 */
export function sanitizeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format number with UK locale
 */
export function formatNumber(num) {
  return new Intl.NumberFormat('en-GB').format(num);
}

/**
 * Format date with UK locale
 */
export function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB');
}

/**
 * Show an alert with the specified type (success or error)
 */
export function showAlert(alertId, type, message) {
  const alert = document.getElementById(alertId);
  if (!alert) return;
  alert.className = `alert visible ${type}`;
  alert.textContent = message;
}

/**
 * Hide an alert
 */
export function hideAlert(alertId) {
  const alert = document.getElementById(alertId);
  if (!alert) return;
  alert.classList.remove('visible');
}

/**
 * Show or hide a screen by ID
 */
export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

/**
 * Show a toast notification (temporary message at bottom-right)
 */
export function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3000);
}
