/**
 * Daksfirst Floating Progress Bar
 * Shared component for all long-running actions across the platform.
 * Usage:
 *   import { floatingProgress } from './floating-progress.js';
 *   floatingProgress.show({ label: 'Parsing...', message: '...', steps: [...] });
 *   floatingProgress.updateStep(0, 'done');
 *   floatingProgress.complete({ label: 'Done', message: '...' });
 */

let _timer = null;
let _startTime = null;

/** Ensure the floating bar HTML exists in the DOM (injected once) */
function _ensureDOM() {
  if (document.getElementById('dkf-float-progress')) return;

  const html = `
    <div id="dkf-float-progress" style="position:fixed;bottom:24px;right:24px;z-index:99999;min-width:360px;max-width:440px;background:#1E293B;border:1px solid rgba(212,168,83,0.3);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(212,168,83,0.1);overflow:hidden;transform:translateY(120%);opacity:0;transition:transform .35s cubic-bezier(.34,1.56,.64,1),opacity .25s ease;pointer-events:none;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px 8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div id="fp-spinner" style="width:18px;height:18px;border:2px solid rgba(212,168,83,0.2);border-top-color:#D4A853;border-radius:50%;animation:fpSpin .8s linear infinite;flex-shrink:0;"></div>
          <span id="fp-label" style="font-size:13px;font-weight:700;color:#F1F5F9;">Processing...</span>
        </div>
        <button onclick="window._fpDismiss && window._fpDismiss()" style="background:none;border:none;color:#64748B;cursor:pointer;font-size:16px;padding:2px 6px;border-radius:4px;" title="Dismiss">&times;</button>
      </div>
      <div style="padding:0 16px 12px;">
        <div id="fp-message" style="font-size:12px;color:#94A3B8;margin-bottom:8px;line-height:1.4;"></div>
        <div id="fp-steps" style="font-size:11px;color:#64748B;margin-bottom:8px;display:none;"></div>
        <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;margin-top:4px;">
          <div id="fp-bar-fill" style="height:100%;border-radius:2px;width:0%;transition:width .5s ease;background:linear-gradient(90deg,#D4A853,#E8C97A);"></div>
        </div>
        <div id="fp-elapsed" style="font-size:10px;color:#64748B;text-align:right;margin-top:4px;"></div>
      </div>
    </div>
    <style>
      @keyframes fpSpin { to { transform: rotate(360deg); } }
    </style>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

/** Show the floating bar */
function show({ label, message, steps } = {}) {
  _ensureDOM();
  const el = document.getElementById('dkf-float-progress');
  const lblEl = document.getElementById('fp-label');
  const msgEl = document.getElementById('fp-message');
  const stepsEl = document.getElementById('fp-steps');
  const barEl = document.getElementById('fp-bar-fill');
  const spinnerEl = document.getElementById('fp-spinner');
  const elapsedEl = document.getElementById('fp-elapsed');

  // Reset styles
  el.style.borderColor = 'rgba(212,168,83,0.3)';
  el.style.transform = 'translateY(0)';
  el.style.opacity = '1';
  el.style.pointerEvents = 'auto';

  lblEl.textContent = label || 'Processing...';
  msgEl.textContent = message || '';
  barEl.style.width = '0%';
  barEl.style.background = 'linear-gradient(90deg,#D4A853,#E8C97A)';
  spinnerEl.style.display = 'block';
  spinnerEl.style.borderTopColor = '#D4A853';
  spinnerEl.style.borderColor = 'rgba(212,168,83,0.2)';
  spinnerEl.style.borderTopColor = '#D4A853';
  elapsedEl.textContent = '';

  if (steps && steps.length) {
    stepsEl.innerHTML = steps.map((s, i) =>
      `<div id="fp-step-${i}" style="display:flex;align-items:center;gap:6px;padding:2px 0;color:#475569;">
        <span style="font-size:12px;width:16px;text-align:center;" id="fp-step-icon-${i}">○</span> ${s}
      </div>`
    ).join('');
    stepsEl.style.display = 'block';
  } else {
    stepsEl.style.display = 'none';
  }

  // Start elapsed timer
  _startTime = Date.now();
  clearInterval(_timer);
  _timer = setInterval(() => {
    const secs = Math.round((Date.now() - _startTime) / 1000);
    elapsedEl.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }, 1000);
}

/** Update a step status: 'done' | 'active' | 'pending' */
function updateStep(index, status) {
  const step = document.getElementById(`fp-step-${index}`);
  const icon = document.getElementById(`fp-step-icon-${index}`);
  if (!step || !icon) return;

  if (status === 'done') {
    step.style.color = '#34D399';
    icon.textContent = '✓';
  } else if (status === 'active') {
    step.style.color = '#D4A853';
    icon.textContent = '◉';
  } else {
    step.style.color = '#475569';
    icon.textContent = '○';
  }
}

/** Update the progress bar percentage (0-100) */
function updateBar(pct) {
  const bar = document.getElementById('fp-bar-fill');
  if (bar) bar.style.width = Math.min(pct, 100) + '%';
}

/** Update the message text */
function updateMessage(msg) {
  const el = document.getElementById('fp-message');
  if (el) el.textContent = msg;
}

/** Update the label text */
function updateLabel(lbl) {
  const el = document.getElementById('fp-label');
  if (el) el.textContent = lbl;
}

/** Show success state — auto-dismisses after 4s */
function complete({ label, message } = {}) {
  _ensureDOM();
  clearInterval(_timer);
  const el = document.getElementById('dkf-float-progress');
  const lblEl = document.getElementById('fp-label');
  const msgEl = document.getElementById('fp-message');
  const barEl = document.getElementById('fp-bar-fill');
  const spinnerEl = document.getElementById('fp-spinner');

  el.style.borderColor = 'rgba(52,211,153,0.4)';
  lblEl.textContent = label || 'Complete!';
  msgEl.textContent = message || '';
  barEl.style.width = '100%';
  barEl.style.background = 'linear-gradient(90deg,#34D399,#6EE7B7)';
  spinnerEl.style.display = 'none';

  setTimeout(() => dismiss(), 4000);
}

/** Show error state */
function error({ label, message } = {}) {
  _ensureDOM();
  clearInterval(_timer);
  const el = document.getElementById('dkf-float-progress');
  const lblEl = document.getElementById('fp-label');
  const msgEl = document.getElementById('fp-message');
  const barEl = document.getElementById('fp-bar-fill');
  const spinnerEl = document.getElementById('fp-spinner');

  el.style.borderColor = 'rgba(248,113,113,0.4)';
  lblEl.textContent = label || 'Error';
  msgEl.textContent = message || '';
  barEl.style.background = 'linear-gradient(90deg,#F87171,#FCA5A5)';
  spinnerEl.style.display = 'none';
}

/** Dismiss / hide the bar */
function dismiss() {
  clearInterval(_timer);
  const el = document.getElementById('dkf-float-progress');
  if (el) {
    el.style.transform = 'translateY(120%)';
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  }
}

// Expose dismiss globally so the close button works
window._fpDismiss = dismiss;

export const floatingProgress = { show, updateStep, updateBar, updateMessage, updateLabel, complete, error, dismiss };
