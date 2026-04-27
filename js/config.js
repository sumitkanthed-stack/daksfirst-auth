// Configuration constants — hostname-aware so the same code works on
// apply.daksfirst.com (production) and apply-staging.daksfirst.com (staging).
const isStaging =
  typeof window !== 'undefined' &&
  window.location.hostname.startsWith('apply-staging');

export const API_BASE = isStaging
  ? 'https://daksfirst-auth-staging.onrender.com'
  : 'https://daksfirst-auth.onrender.com';

// Phase E.2 (2026-04-27) — N8N_WEBHOOK is the DEAL-SUBMISSION webhook
// (broker submits deal → n8n Deal Intake canvas). Both environments share
// the same n8n Cloud account; only the canvas + credential differ.
export const N8N_WEBHOOK = isStaging
  ? 'https://sumitkanthed.app.n8n.cloud/webhook/ba694728-a8f9-4885-af19-483e93afb10f'
  : 'https://sumitkanthed.app.n8n.cloud/webhook/4c811581-2d51-4432-aef1-2c04d53fe71c';
