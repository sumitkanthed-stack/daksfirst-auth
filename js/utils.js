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
 * Parse a formatted number string back to a raw number
 * Strips commas, £ signs, spaces
 */
export function parseFormattedNumber(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[£,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Attach live comma-formatting to a text input field (for £ amounts)
 * Converts input on the fly: 2500000 → 2,500,000
 * Stores raw value in data-raw attribute for form reads
 */
export function attachMoneyFormat(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  // Format existing value on attach
  const raw = parseFormattedNumber(el.value);
  if (raw > 0) {
    el.setAttribute('data-raw', raw);
    el.value = formatNumber(raw);
  }
  el.addEventListener('input', () => {
    const cursorPos = el.selectionStart;
    const oldLen = el.value.length;
    const rawVal = parseFormattedNumber(el.value);
    el.setAttribute('data-raw', rawVal);
    if (rawVal > 0) {
      el.value = formatNumber(rawVal);
    }
    // Try to preserve cursor position
    const newLen = el.value.length;
    const diff = newLen - oldLen;
    el.setSelectionRange(cursorPos + diff, cursorPos + diff);
  });
  el.addEventListener('focus', () => {
    // On focus, show raw number for easier editing
    const raw = parseFormattedNumber(el.value);
    if (raw > 0) el.value = raw;
  });
  el.addEventListener('blur', () => {
    // On blur, format with commas
    const raw = parseFormattedNumber(el.value);
    el.setAttribute('data-raw', raw);
    if (raw > 0) {
      el.value = formatNumber(raw);
    }
  });
}

/**
 * Get the raw numeric value from a money-formatted input
 */
export function getMoneyValue(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return 0;
  return parseFormattedNumber(el.getAttribute('data-raw') || el.value);
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
