-- ═══════════════════════════════════════════════════════════════════════════
-- Daksfirst Auth Portal — Database Setup
-- Run this once against the Render PostgreSQL database
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Users table (brokers + borrowers)
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  role            VARCHAR(20)   NOT NULL CHECK (role IN ('broker', 'borrower')),
  first_name      VARCHAR(100)  NOT NULL,
  last_name       VARCHAR(100)  NOT NULL,
  email           VARCHAR(255)  NOT NULL UNIQUE,
  phone           VARCHAR(30)   NOT NULL,
  company         VARCHAR(200),
  fca_number      VARCHAR(50),
  loan_purpose    VARCHAR(50),
  loan_amount     NUMERIC(15,2),
  source          VARCHAR(50)   DEFAULT 'portal',
  password_hash   TEXT          NOT NULL,
  verification_token TEXT,
  email_verified  BOOLEAN       DEFAULT FALSE,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role  ON users(role);

-- 2. Deal submissions table
CREATE TABLE IF NOT EXISTS deal_submissions (
  id                SERIAL PRIMARY KEY,
  submission_id     UUID          DEFAULT gen_random_uuid() UNIQUE,
  user_id           INT           REFERENCES users(id),
  status            VARCHAR(30)   DEFAULT 'received' CHECK (status IN ('received','processing','completed','failed','declined')),

  -- Borrower / applicant
  borrower_name     VARCHAR(200),
  borrower_company  VARCHAR(200),
  borrower_email    VARCHAR(255),
  borrower_phone    VARCHAR(30),

  -- Broker (if submitted by broker)
  broker_name       VARCHAR(200),
  broker_company    VARCHAR(200),
  broker_fca        VARCHAR(50),

  -- Security / property
  security_address  TEXT,
  security_postcode VARCHAR(15),
  asset_type        VARCHAR(50),
  current_value     NUMERIC(15,2),

  -- Loan
  loan_amount       NUMERIC(15,2),
  ltv_requested     NUMERIC(5,2),
  loan_purpose      VARCHAR(100),
  exit_strategy     TEXT,
  term_months       INT,
  rate_requested    NUMERIC(5,2),

  -- Documents (JSON array of {type, filename, url})
  documents         JSONB         DEFAULT '[]'::jsonb,

  -- Notes
  additional_notes  TEXT,

  -- Webhook tracking
  webhook_status    VARCHAR(20)   DEFAULT 'pending' CHECK (webhook_status IN ('pending','sent','failed','retrying')),
  webhook_attempts  INT           DEFAULT 0,
  webhook_last_try  TIMESTAMPTZ,
  webhook_response  TEXT,

  -- Source
  source            VARCHAR(50)   DEFAULT 'web_form',

  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_status      ON deal_submissions(status);
CREATE INDEX IF NOT EXISTS idx_deals_user        ON deal_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_deals_submission   ON deal_submissions(submission_id);
CREATE INDEX IF NOT EXISTS idx_deals_webhook      ON deal_submissions(webhook_status);

-- 3. Webhook event log
CREATE TABLE IF NOT EXISTS webhook_log (
  id              SERIAL PRIMARY KEY,
  deal_id         INT           REFERENCES deal_submissions(id),
  attempt         INT           NOT NULL,
  status_code     INT,
  response_body   TEXT,
  error_message   TEXT,
  sent_at         TIMESTAMPTZ   DEFAULT NOW()
);
