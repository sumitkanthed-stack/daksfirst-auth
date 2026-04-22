require('dotenv').config();

module.exports = {
  // Server config
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Database
  DATABASE_URL: process.env.DATABASE_URL,

  // JWT — fail-fast if missing or weak (audit hardening 2026-04-20)
  JWT_SECRET: (() => {
    if (!process.env.JWT_SECRET) {
      throw new Error('[config] JWT_SECRET env var is required — refusing to start');
    }
    if (process.env.JWT_SECRET.length < 32) {
      throw new Error('[config] JWT_SECRET must be at least 32 characters — refusing to start');
    }
    return process.env.JWT_SECRET;
  })(),
  JWT_EXPIRY: '15m',
  JWT_REFRESH_EXPIRY: '7d',

  // Webhook shared secret — fail-fast if missing or weak (audit hardening 2026-04-20)
  WEBHOOK_SECRET: (() => {
    if (!process.env.WEBHOOK_SECRET) {
      throw new Error('[config] WEBHOOK_SECRET env var is required — refusing to start');
    }
    if (process.env.WEBHOOK_SECRET.length < 32) {
      throw new Error('[config] WEBHOOK_SECRET must be at least 32 characters — refusing to start');
    }
    return process.env.WEBHOOK_SECRET;
  })(),

  // CORS
  CORS_ORIGINS: [
    'https://apply.daksfirst.com',
    'https://daksfirst-auth.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ],

  // Rate limiting (windowMs in milliseconds, max requests)
  RATE_LIMITS: {
    auth: { windowMs: 15 * 60 * 1000, max: 20 },
    deals: { windowMs: 60 * 60 * 1000, max: 100 },
    admin: { windowMs: 15 * 60 * 1000, max: 100 }
  },

  // Multer file upload
  MULTER: {
    maxFileSize: 25 * 1024 * 1024, // 25MB per file
    maxFiles: 10
  },

  // Microsoft Graph / Azure AD
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID || '',
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID || '',
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET || '',
  GRAPH_USER_EMAIL: 'portal@daksfirst.com',
  ONEDRIVE_ROOT: 'Daksfirst Deals',

  // Anthropic AI (for document categorisation)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',

  // n8n webhooks
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
  N8N_PARSE_WEBHOOK_URL: process.env.N8N_PARSE_WEBHOOK_URL || '',
  N8N_DATA_PARSE_URL: process.env.N8N_DATA_PARSE_URL || '',
  N8N_DATA_CLASSIFY_URL: process.env.N8N_DATA_CLASSIFY_URL || '',
// Output Engine (OE-3, 2026-04-22)
  //   Production webhook on the cloned "Credit Analysis - Admin Run" workflow
  //   in n8n Cloud. Auth dispatcher POSTs the full feature envelope here and
  //   n8n asynchronously posts three base64 DOCX blobs back to the auth
  //   callback at /api/webhook/output-engine/complete.
  N8N_OUTPUT_ENGINE_WEBHOOK_URL: process.env.N8N_OUTPUT_ENGINE_WEBHOOK_URL || '',

  // Public base URL for THIS service (used when auth hands an n8n workflow
  // an absolute callback URL to POST back to). Render is authoritative for
  // webhook inbound; Vercel is frontend-only.
  AUTH_PUBLIC_BASE_URL: process.env.AUTH_PUBLIC_BASE_URL || 'https://daksfirst-auth.onrender.com',
  // DocuSign
  DOCUSIGN_INTEGRATION_KEY: process.env.DOCUSIGN_INTEGRATION_KEY || '',
  DOCUSIGN_ACCOUNT_ID: process.env.DOCUSIGN_ACCOUNT_ID || '',
  DOCUSIGN_USER_ID: process.env.DOCUSIGN_USER_ID || '',
  DOCUSIGN_PRIVATE_KEY: (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  DOCUSIGN_BASE_URL: process.env.DOCUSIGN_BASE_URL || 'https://demo.docusign.net/restapi',
  DOCUSIGN_AUTH_SERVER: process.env.DOCUSIGN_AUTH_SERVER || 'https://account-d.docusign.com',
  DOCUSIGN_WEBHOOK_URL: process.env.DOCUSIGN_WEBHOOK_URL || 'https://daksfirst-auth.onrender.com/api/docusign/webhook',

  // Companies House API
  COMPANIES_HOUSE_API_KEY: process.env.COMPANIES_HOUSE_API_KEY || '',

  // EPC Register API (free — register at https://epc.opendatacommunities.org/login)
  EPC_API_KEY: process.env.EPC_API_KEY || '',
  EPC_API_EMAIL: process.env.EPC_API_EMAIL || '',

  // Chimnie Property Intelligence API (paid tier) — 2026-04-21
  //   Auth: ?api_key=xxx query parameter. Base URL: https://api.chimnie.com.
  //   Cost: per-call credit spend; see /info/credits for remaining balance.
  //   Monthly cap stops runaway spend on bugs — set in credits (not GBP).
  CHIMNIE_API_KEY: process.env.CHIMNIE_API_KEY || '',
  CHIMNIE_BASE_URL: process.env.CHIMNIE_BASE_URL || 'https://api.chimnie.com',
  CHIMNIE_TIMEOUT_MS: parseInt(process.env.CHIMNIE_TIMEOUT_MS || '15000', 10),
  CHIMNIE_MONTHLY_CAP_CREDITS: parseInt(process.env.CHIMNIE_MONTHLY_CAP_CREDITS || '5000', 10),

  // Daksfirst Alpha (risk modeling engine) — calls this service for deal scoring.
  //   Alpha is deployed separately on Render (Frankfurt EEA for data residency).
  //   Auth never sends PII; only sanitised feature vectors. If alpha is
  //   unreachable, auth degrades gracefully — do not hard-fail deal flow.
  ALPHA_BASE_URL: process.env.ALPHA_BASE_URL || '',
  ALPHA_API_KEY: process.env.ALPHA_API_KEY || '',
  ALPHA_WEBHOOK_SECRET: process.env.ALPHA_WEBHOOK_SECRET || '',

  // Twilio SMS
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || '',

  // Email templates
  BRAND_NAME: 'Daksfirst Limited',
  BRAND_COLOR_PRIMARY: '#1a365d', // Navy
  BRAND_COLOR_ACCENT: '#c9a84c',  // Gold
  VERIFICATION_URL_BASE: 'https://apply.daksfirst.com/verify',

  // Deal stages
  DEAL_STAGES: [
    'received',
    'assigned',
    'dip_issued',
    'info_gathering',
    'ai_termsheet',
    'fee_pending',
    'fee_paid',
    'underwriting',
    'bank_submitted',
    'bank_approved',
    'borrower_accepted',
    'legal_instructed',
    'completed',
    'declined',
    'withdrawn'
  ],

  DEAL_STATUSES: [
    'received',
    'assigned',
    'dip_issued',
    'info_gathering',
    'ai_termsheet',
    'fee_pending',
    'fee_paid',
    'underwriting',
    'bank_submitted',
    'bank_approved',
    'borrower_accepted',
    'legal_instructed',
    'completed',
    'declined',
    'withdrawn'
  ],

  // User roles
  USER_ROLES: ['broker', 'borrower', 'admin', 'rm', 'credit', 'compliance'],
  INTERNAL_ROLES: ['admin', 'rm', 'credit', 'compliance'],

  // Borrower roles
  BORROWER_ROLES: ['primary', 'joint', 'guarantor', 'director'],

  // KYC status
  KYC_STATUS: ['pending', 'submitted', 'verified', 'rejected'],

  // Broker onboarding status
  BROKER_ONBOARDING_STATUS: ['pending', 'submitted', 'under_review', 'approved', 'rejected'],

  // Onboarding tabs
  ONBOARDING_TABS: ['kyc', 'financials', 'valuation', 'refurbishment', 'exit_evidence', 'aml', 'insurance'],

  // Phase 2 unlock condition
  PHASE2_UNLOCK_STAGES: ['termsheet_signed', 'underwriting', 'approved', 'legal', 'completed'],

  // Approval decisions
  APPROVAL_DECISIONS: ['approve', 'decline', 'more_info'],

  // Email event types for notifications
  EMAIL_EVENTS: {
    DIP_ISSUED: 'dip_issued',
    CREDIT_APPROVED: 'credit_approved',
    FEE_REQUESTED: 'fee_requested',
    BANK_APPROVED: 'bank_approved',
    DEAL_COMPLETED: 'deal_completed',
    DEAL_DECLINED: 'deal_declined'
  },

  // SMS event types for notifications
  SMS_EVENTS: {
    DIP_APPROVAL: 'dip_approval',
    FEE_REQUEST: 'fee_request',
    BANK_APPROVAL: 'bank_approval'
  }
};
