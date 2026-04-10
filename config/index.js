require('dotenv').config();

module.exports = {
  // Server config
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Database
  DATABASE_URL: process.env.DATABASE_URL,

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'daksfirst_default_secret',
  JWT_EXPIRY: '15m',
  JWT_REFRESH_EXPIRY: '7d',

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

  // n8n webhook
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',

  // DocuSign
  DOCUSIGN_INTEGRATION_KEY: process.env.DOCUSIGN_INTEGRATION_KEY || '',
  DOCUSIGN_ACCOUNT_ID: process.env.DOCUSIGN_ACCOUNT_ID || '',
  DOCUSIGN_USER_ID: process.env.DOCUSIGN_USER_ID || '',
  DOCUSIGN_PRIVATE_KEY: (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  DOCUSIGN_BASE_URL: process.env.DOCUSIGN_BASE_URL || 'https://demo.docusign.net/restapi',
  DOCUSIGN_AUTH_SERVER: process.env.DOCUSIGN_AUTH_SERVER || 'https://account-d.docusign.com',
  DOCUSIGN_WEBHOOK_URL: process.env.DOCUSIGN_WEBHOOK_URL || 'https://daksfirst-auth.onrender.com/api/docusign/webhook',

  // Twilio SMS
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || '',

  // Seed secret (for admin creation - remove after first use)
  SEED_SECRET: 'daksfirst-seed-2026',

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
