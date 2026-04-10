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
 * Format whole number with UK locale comma separation (no decimals)
 * Use for: loan amounts, valuations, property values, fees
 */
export function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(Number(num)));
}

/**
 * Format percentage/LTV to 2 decimal places
 * Use for: LTV, rates, arrangement fee percentages
 */
export function formatPct(num) {
  if (num === null || num === undefined || isNaN(num)) return '0.00';
  return Number(num).toFixed(2);
}

/**
 * Format date with UK locale (date only)
 */
export function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB');
}

/**
 * Format date with UK locale including time (for audit trail)
 */
export function formatDateTime(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB') + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
