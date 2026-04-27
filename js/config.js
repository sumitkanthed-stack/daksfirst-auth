// Configuration constants — hostname-aware so the same code works on
// apply.daksfirst.com (production) and apply-staging.daksfirst.com (staging).
const isStaging =
  typeof window !== 'undefined' &&
  window.location.hostname.startsWith('apply-staging');

export const API_BASE = isStaging
  ? 'https://daksfirst-auth-staging.onrender.com'
  : 'https://daksfirst-auth.onrender.com';

// NOTE: staging n8n webhook ID is set in Phase E.2 (canvas clones with [STG]
// prefix). Until then the placeholder will fail loudly on staging — by design.
export const N8N_WEBHOOK = isStaging
  ? 'https://sumitkanthed.app.n8n.cloud/webhook/STAGING_PENDING_E2'
  : 'https://sumitkanthed.app.n8n.cloud/webhook/4c811581-2d51-4432-aef1-2c04d53fe71c';
