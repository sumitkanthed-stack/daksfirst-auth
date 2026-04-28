const pool = require('./pool');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  try {
    console.log('[migrate] Running database migrations...');

    // Users table with admin role support
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        role            VARCHAR(20)   NOT NULL CHECK (role IN ('broker', 'borrower', 'admin')),
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
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_role  ON users(role);`);

    // Refresh tokens table (for JWT refresh token functionality)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id              SERIAL PRIMARY KEY,
        user_id         INT           REFERENCES users(id) ON DELETE CASCADE,
        token           TEXT          NOT NULL UNIQUE,
        expires_at      TIMESTAMPTZ   NOT NULL,
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);`);

    // Deal submissions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_submissions (
        id                SERIAL PRIMARY KEY,
        submission_id     UUID          DEFAULT gen_random_uuid() UNIQUE,
        user_id           INT           REFERENCES users(id),
        status            VARCHAR(30)   DEFAULT 'received' CHECK (status IN ('received','processing','completed','failed','declined')),
        borrower_name     VARCHAR(200),
        borrower_company  VARCHAR(200),
        borrower_email    VARCHAR(255),
        borrower_phone    VARCHAR(30),
        broker_name       VARCHAR(200),
        broker_company    VARCHAR(200),
        broker_fca        VARCHAR(50),
        security_address  TEXT,
        security_postcode VARCHAR(15),
        asset_type        VARCHAR(50),
        current_value     NUMERIC(15,2),
        loan_amount       NUMERIC(15,2),
        ltv_requested     NUMERIC(5,2),
        loan_purpose      VARCHAR(100),
        exit_strategy     TEXT,
        term_months       INT,
        rate_requested    NUMERIC(5,2),
        documents         JSONB         DEFAULT '[]'::jsonb,
        additional_notes  TEXT,
        admin_notes       TEXT,
        assigned_to       INT           REFERENCES users(id),
        internal_status   VARCHAR(50)   DEFAULT 'new',
        webhook_status    VARCHAR(20)   DEFAULT 'pending' CHECK (webhook_status IN ('pending','sent','failed','retrying')),
        webhook_attempts  INT           DEFAULT 0,
        webhook_last_try  TIMESTAMPTZ,
        webhook_response  TEXT,
        source            VARCHAR(50)   DEFAULT 'web_form',
        created_at        TIMESTAMPTZ   DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_status      ON deal_submissions(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_user        ON deal_submissions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_submission   ON deal_submissions(submission_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_webhook      ON deal_submissions(webhook_status);`);

    // Webhook log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_log (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        attempt         INT           NOT NULL,
        status_code     INT,
        response_body   TEXT,
        error_message   TEXT,
        sent_at         TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    // Deal documents table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_documents (
        id                SERIAL PRIMARY KEY,
        deal_id           INT           REFERENCES deal_submissions(id),
        filename          VARCHAR(500)  NOT NULL,
        file_type         VARCHAR(50),
        file_size         INT,
        file_content      BYTEA,
        onedrive_item_id  TEXT,
        onedrive_path     TEXT,
        onedrive_download_url TEXT,
        parse_session_id  UUID,
        uploaded_at       TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_docs_deal ON deal_documents(deal_id);`);

    // Add doc_category column for onboarding section categorisation
    try {
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS doc_category VARCHAR(50);`);
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS uploaded_by INT REFERENCES users(id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_docs_category ON deal_documents(doc_category);`);
      // Accepted state — locks the document after verification
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;`);
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS accepted_by INT REFERENCES users(id);`);
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS accepted_name VARCHAR(200);`);
      // Document validity dates — expiry for KYC, issue date for valuations/statements
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS doc_expiry_date DATE;`);
      await pool.query(`ALTER TABLE deal_documents ADD COLUMN IF NOT EXISTS doc_issue_date DATE;`);
    } catch (err) {
      console.log('[migrate] Note on doc_category:', err.message.substring(0, 60));
    }

    // Widen file_type columns — Office MIME types (e.g. .pptx, .docx) exceed 50 chars
    try {
      await pool.query(`ALTER TABLE deal_documents ALTER COLUMN file_type TYPE VARCHAR(255);`);
      await pool.query(`ALTER TABLE deal_document_repo ALTER COLUMN file_type TYPE VARCHAR(255);`);
    } catch (err) {
      console.log('[migrate] Note on file_type widen:', err.message.substring(0, 60));
    }

    // Analysis results table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analysis_results (
        id                SERIAL PRIMARY KEY,
        deal_id           INT           REFERENCES deal_submissions(id) UNIQUE,
        credit_memo_url   TEXT,
        termsheet_url     TEXT,
        gbb_memo_url      TEXT,
        analysis_json     JSONB,
        completed_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analysis_deal ON analysis_results(deal_id);`);

    // Client notes table (CRM)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS client_notes (
        id                SERIAL PRIMARY KEY,
        user_id           INT           REFERENCES users(id),
        deal_id           INT           REFERENCES deal_submissions(id),
        note              TEXT          NOT NULL,
        created_by        INT           REFERENCES users(id),
        created_at        TIMESTAMPTZ   DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_user ON client_notes(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_deal ON client_notes(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notes_creator ON client_notes(created_by);`);

    // Deal audit log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_audit_log (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        action          VARCHAR(100)  NOT NULL,
        from_value      TEXT,
        to_value        TEXT,
        details         JSONB,
        performed_by    INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_deal ON deal_audit_log(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON deal_audit_log(performed_by);`);

    // Fee payments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_fee_payments (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        fee_type        VARCHAR(50)   NOT NULL,
        amount          NUMERIC(15,2) NOT NULL,
        payment_date    DATE          NOT NULL,
        payment_ref     VARCHAR(200),
        notes           TEXT,
        confirmed_by    INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fees_deal ON deal_fee_payments(deal_id);`);

    // Deal approvals table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_approvals (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        approval_stage  VARCHAR(50)   NOT NULL,
        decision        VARCHAR(20)   NOT NULL CHECK (decision IN ('approve', 'decline', 'more_info')),
        comments        TEXT,
        decided_by      INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_approvals_deal ON deal_approvals(deal_id);`);

    // Broker onboarding table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broker_onboarding (
        id              SERIAL PRIMARY KEY,
        user_id         INT           REFERENCES users(id) UNIQUE,
        status          VARCHAR(30)   DEFAULT 'pending' CHECK (status IN ('pending','submitted','under_review','approved','rejected')),
        individual_name VARCHAR(200),
        date_of_birth   DATE,
        passport_doc_id INT,
        proof_of_address_doc_id INT,
        is_company      BOOLEAN       DEFAULT FALSE,
        company_name    VARCHAR(200),
        company_number  VARCHAR(50),
        incorporation_doc_id INT,
        bank_name       VARCHAR(200),
        bank_sort_code  VARCHAR(10),
        bank_account_no VARCHAR(20),
        bank_account_name VARCHAR(200),
        notes           TEXT,
        reviewed_by     INT           REFERENCES users(id),
        reviewed_at     TIMESTAMPTZ,
        default_rm      INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_onb_user ON broker_onboarding(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_onb_status ON broker_onboarding(status);`);

    // Law firms table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS law_firms (
        id              SERIAL PRIMARY KEY,
        firm_name       VARCHAR(200)  NOT NULL,
        contact_name    VARCHAR(200),
        email           VARCHAR(255),
        phone           VARCHAR(30),
        address         TEXT,
        notes           TEXT,
        is_active       BOOLEAN       DEFAULT TRUE,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_law_firms_active ON law_firms(is_active);`);

    // Deal borrowers table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_borrowers (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        role            VARCHAR(30)   DEFAULT 'primary' CHECK (role IN ('primary','joint','guarantor','director')),
        full_name       VARCHAR(200)  NOT NULL,
        date_of_birth   DATE,
        nationality     VARCHAR(100),
        jurisdiction    VARCHAR(100),
        email           VARCHAR(255),
        phone           VARCHAR(30),
        address         TEXT,
        borrower_type   VARCHAR(30)   DEFAULT 'individual',
        company_name    VARCHAR(200),
        company_number  VARCHAR(50),
        kyc_status      VARCHAR(30)   DEFAULT 'pending' CHECK (kyc_status IN ('pending','submitted','verified','rejected')),
        kyc_data        JSONB         DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_borrowers_deal ON deal_borrowers(deal_id);`);

    // Deal properties table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_properties (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        address         TEXT          NOT NULL,
        postcode        VARCHAR(15),
        property_type   VARCHAR(50),
        tenure          VARCHAR(30),
        occupancy       VARCHAR(30),
        current_use     VARCHAR(50),
        market_value    NUMERIC(15,2),
        purchase_price  NUMERIC(15,2),
        gdv             NUMERIC(15,2),
        reinstatement   NUMERIC(15,2),
        day1_ltv        NUMERIC(5,2),
        title_number    VARCHAR(50),
        title_doc_id    INT,
        valuation_doc_id INT,
        valuation_date  DATE,
        insurance_doc_id INT,
        insurance_sum   NUMERIC(15,2),
        solicitor_firm  VARCHAR(200),
        solicitor_ref   VARCHAR(100),
        notes           TEXT,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_props_deal ON deal_properties(deal_id);`);

    // Deal field status table (per-field, per-stage matrix tracking)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_field_status (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        section         VARCHAR(50)   NOT NULL,
        field_key       VARCHAR(100)  NOT NULL,
        stage           VARCHAR(30)   NOT NULL,
        status          VARCHAR(30)   DEFAULT 'not_started' CHECK (status IN ('not_required','not_started','submitted','under_review','approved','finalized','locked')),
        updated_by      INT           REFERENCES users(id),
        updated_at      TIMESTAMPTZ   DEFAULT NOW(),
        UNIQUE(deal_id, field_key, stage)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_field_status_deal ON deal_field_status(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_field_status_section ON deal_field_status(section);`);

    // Deal info requests table (information requests per section)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_info_requests (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        section         VARCHAR(50)   NOT NULL,
        message         TEXT          NOT NULL,
        requested_by    INT           REFERENCES users(id),
        requested_role  VARCHAR(20),
        status          VARCHAR(20)   DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
        resolved_by     INT           REFERENCES users(id),
        resolved_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_info_req_deal ON deal_info_requests(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_info_req_status ON deal_info_requests(status);`);

    // Deal documents issued table (documents issued at each stage)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_documents_issued (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        doc_type        VARCHAR(50)   NOT NULL,
        stage           VARCHAR(30)   NOT NULL,
        reference       VARCHAR(100),
        issued_at       TIMESTAMPTZ,
        issued_by       INT           REFERENCES users(id),
        sent_to         TEXT,
        signing_method  VARCHAR(30),
        signed_at       TIMESTAMPTZ,
        signed_status   VARCHAR(30)   DEFAULT 'not_issued' CHECK (signed_status IN ('not_issued','issued','sent','awaiting_signature','signed','countersigned','superseded')),
        validity_days   INT,
        file_url        TEXT,
        signed_file_url TEXT,
        envelope_id     VARCHAR(100),
        notes           TEXT,
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_docs_issued_deal ON deal_documents_issued(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_docs_issued_type ON deal_documents_issued(doc_type);`);

    // Deal document repo table (central document repository with categorization)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_document_repo (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id),
        filename        VARCHAR(500)  NOT NULL,
        file_type       VARCHAR(50),
        file_size       INT,
        category        VARCHAR(50),
        section         VARCHAR(50),
        status          VARCHAR(30)   DEFAULT 'uploaded' CHECK (status IN ('uploaded','verified','pending','missing','requested','rejected')),
        uploaded_by     INT           REFERENCES users(id),
        verified_by     INT           REFERENCES users(id),
        verified_at     TIMESTAMPTZ,
        source_doc_id   INT,
        auto_parsed     BOOLEAN       DEFAULT false,
        parse_confidence VARCHAR(10),
        notes           TEXT,
        created_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_doc_repo_deal ON deal_document_repo(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_doc_repo_category ON deal_document_repo(category);`);

    // Update users role constraint
    try {
      await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`);
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('broker', 'borrower', 'admin', 'rm', 'credit', 'compliance'));`);
      console.log('[migrate] Updated users table role constraint (6 roles)');
    } catch (err) {
      console.log('[migrate] Could not update users role constraint:', err.message.substring(0, 60));
    }

    // Add columns to deal_submissions if they don't exist
    const columnChecks = [
      { col: 'admin_notes', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS admin_notes TEXT;' },
      { col: 'assigned_to', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id);' },
      { col: 'internal_status', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS internal_status VARCHAR(50) DEFAULT \'new\';' },
      { col: 'borrower_dob', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_dob DATE;' },
      { col: 'borrower_nationality', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_nationality VARCHAR(100);' },
      { col: 'borrower_jurisdiction', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_jurisdiction VARCHAR(100);' },
      { col: 'borrower_type', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_type VARCHAR(50);' },
      { col: 'company_name', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS company_name VARCHAR(200);' },
      { col: 'company_number', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS company_number VARCHAR(50);' },
      { col: 'drawdown_date', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS drawdown_date DATE;' },
      { col: 'interest_servicing', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS interest_servicing VARCHAR(30);' },
      { col: 'existing_charges', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS existing_charges TEXT;' },
      { col: 'property_tenure', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS property_tenure VARCHAR(30);' },
      { col: 'occupancy_status', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS occupancy_status VARCHAR(30);' },
      { col: 'current_use', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS current_use VARCHAR(50);' },
      { col: 'purchase_price', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(15,2);' },
      { col: 'use_of_funds', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS use_of_funds TEXT;' },
      { col: 'refurb_scope', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS refurb_scope TEXT;' },
      { col: 'refurb_cost', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS refurb_cost NUMERIC(15,2);' },
      { col: 'deposit_source', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS deposit_source TEXT;' },
      { col: 'concurrent_transactions', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS concurrent_transactions TEXT;' },
      { col: 'onboarding_data', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS onboarding_data JSONB DEFAULT \'{}\'::jsonb;' },
      { col: 'deal_stage', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS deal_stage VARCHAR(30) DEFAULT \'received\';' },
      { col: 'termsheet_signed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS termsheet_signed_at TIMESTAMPTZ;' },
      { col: 'commitment_fee_received', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS commitment_fee_received BOOLEAN DEFAULT FALSE;' },
      { col: 'assigned_rm', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_rm INT REFERENCES users(id);' },
      { col: 'assigned_credit', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_credit INT REFERENCES users(id);' },
      { col: 'assigned_compliance', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS assigned_compliance INT REFERENCES users(id);' },
      { col: 'dip_fee_confirmed', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_fee_confirmed BOOLEAN DEFAULT FALSE;' },
      { col: 'dip_fee_confirmed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_fee_confirmed_at TIMESTAMPTZ;' },
      { col: 'commitment_fee_confirmed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS commitment_fee_confirmed_at TIMESTAMPTZ;' },
      // Fee percentage columns — saved by matrix UI, referenced by DIP/TS generators (audit fix 2026-04-20)
      { col: 'arrangement_fee_pct', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS arrangement_fee_pct NUMERIC(6,3);' },
      { col: 'broker_fee_pct', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS broker_fee_pct NUMERIC(6,3);' },
      { col: 'commitment_fee', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS commitment_fee NUMERIC(15,2);' },
      { col: 'retained_interest_months', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS retained_interest_months INTEGER;' },
      // Share charge election — RM sets this when thin-cap protection is needed (G5, 2026-04-20)
      // null = RM to elect, 'required', 'not_required'
      { col: 'requires_share_charge', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS requires_share_charge VARCHAR(20);" },
      // G5.3 — Matrix Security & Guarantee section: per-property charge election + free-text encumbrance notes
      // Default 'first_charge'; values: 'first_charge' | 'second_charge' | 'third_charge' | 'no_charge'
      { col: 'additional_security_text', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS additional_security_text TEXT;" },
      { col: 'rm_recommendation', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS rm_recommendation VARCHAR(20);" },
      { col: 'credit_recommendation', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS credit_recommendation VARCHAR(20);" },
      { col: 'compliance_recommendation', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS compliance_recommendation VARCHAR(20);" },
      { col: 'final_decision', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_decision VARCHAR(20);" },
      { col: 'final_decision_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_decision_by INT REFERENCES users(id);' },
      { col: 'final_decision_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_decision_at TIMESTAMPTZ;' },
      { col: 'submitted_to_credit_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS submitted_to_credit_at TIMESTAMPTZ;' },
      { col: 'submitted_to_compliance_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS submitted_to_compliance_at TIMESTAMPTZ;' },
      { col: 'borrower_user_id', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_user_id INT REFERENCES users(id);' },
      { col: 'dip_issued_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_issued_at TIMESTAMPTZ;' },
      { col: 'dip_issued_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_issued_by INT REFERENCES users(id);' },
      { col: 'dip_notes', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_notes TEXT;' },
      { col: 'ai_termsheet_data', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ai_termsheet_data JSONB DEFAULT \'{}\'::jsonb;' },
      { col: 'ai_termsheet_generated_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ai_termsheet_generated_at TIMESTAMPTZ;' },
      { col: 'fee_requested_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fee_requested_at TIMESTAMPTZ;' },
      { col: 'fee_requested_amount', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fee_requested_amount NUMERIC(15,2);' },
      { col: 'bank_submitted_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_submitted_at TIMESTAMPTZ;' },
      { col: 'bank_submitted_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_submitted_by INT REFERENCES users(id);' },
      { col: 'bank_reference', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(100);' },
      { col: 'bank_approved_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_approved_at TIMESTAMPTZ;' },
      { col: 'bank_approval_notes', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS bank_approval_notes TEXT;' },
      { col: 'estimated_net_worth', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS estimated_net_worth NUMERIC(15,2);' },
      { col: 'source_of_wealth', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS source_of_wealth TEXT;' },
      { col: 'borrower_accepted_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_accepted_at TIMESTAMPTZ;' },
      { col: 'legal_instructed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS legal_instructed_at TIMESTAMPTZ;' },
      { col: 'lawyer_firm', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_firm VARCHAR(200);' },
      { col: 'lawyer_email', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_email VARCHAR(255);' },
      { col: 'lawyer_contact', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_contact VARCHAR(30);' },
      { col: 'lawyer_reference', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS lawyer_reference VARCHAR(100);' },
      { col: 'completed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;' },
      { col: 'borrower_invited_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_invited_at TIMESTAMPTZ;' },
      { col: 'borrower_invite_email', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_invite_email VARCHAR(255);' },
      // DocuSign / DIP PDF columns
      { col: 'dip_pdf_url', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_pdf_url TEXT;' },
      { col: 'dip_signed', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_signed BOOLEAN DEFAULT false;' },
      { col: 'dip_signed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_signed_at TIMESTAMPTZ;' },
      { col: 'dip_signed_pdf_url', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_signed_pdf_url TEXT;' },
      { col: 'docusign_envelope_id', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS docusign_envelope_id VARCHAR(100);' },
      { col: 'docusign_status', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS docusign_status VARCHAR(30) DEFAULT 'none';" },
      // Termsheet DocuSign columns
      { col: 'ts_pdf_url', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_pdf_url TEXT;' },
      { col: 'ts_issued_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_issued_at TIMESTAMPTZ;' },
      { col: 'ts_issued_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_issued_by INT REFERENCES users(id);' },
      { col: 'ts_signed', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_signed BOOLEAN DEFAULT false;' },
      { col: 'ts_signed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_signed_at TIMESTAMPTZ;' },
      { col: 'ts_signed_pdf_url', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_signed_pdf_url TEXT;' },
      { col: 'ts_docusign_envelope_id', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_docusign_envelope_id VARCHAR(100);' },
      { col: 'ts_docusign_status', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS ts_docusign_status VARCHAR(30) DEFAULT 'none';" },
      // Facility Letter DocuSign columns
      { col: 'fl_pdf_url', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_pdf_url TEXT;' },
      { col: 'fl_issued_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_issued_at TIMESTAMPTZ;' },
      { col: 'fl_issued_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_issued_by INT REFERENCES users(id);' },
      { col: 'fl_signed', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_signed BOOLEAN DEFAULT false;' },
      { col: 'fl_signed_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_signed_at TIMESTAMPTZ;' },
      { col: 'fl_signed_pdf_url', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_signed_pdf_url TEXT;' },
      { col: 'fl_docusign_envelope_id', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_docusign_envelope_id VARCHAR(100);' },
      { col: 'fl_docusign_status', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS fl_docusign_status VARCHAR(30) DEFAULT 'none';" },
      // Onboarding approval tracking (per-section RM sign-off)
      { col: 'onboarding_approval', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS onboarding_approval JSONB DEFAULT '{}'::jsonb;" },
      // Dual sign-off: RM and Credit on AI termsheet
      { col: 'rm_signoff_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS rm_signoff_at TIMESTAMPTZ;' },
      { col: 'rm_signoff_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS rm_signoff_by INT REFERENCES users(id);' },
      { col: 'credit_signoff_at', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS credit_signoff_at TIMESTAMPTZ;' },
      { col: 'credit_signoff_by', sql: 'ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS credit_signoff_by INT REFERENCES users(id);' },
      // Term snapshots — captured at each gate for side-by-side comparison & field locking
      { col: 'dip_snapshot', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_snapshot JSONB;" },
      { col: 'termsheet_snapshot', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS termsheet_snapshot JSONB;" },
      { col: 'final_snapshot', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS final_snapshot JSONB;" },
      // Matrix data columns
      { col: 'matrix_data', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS matrix_data JSONB DEFAULT '{}'::jsonb;" },
      { col: 'borrower_financials', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS borrower_financials JSONB DEFAULT '{}'::jsonb;" },
      { col: 'aml_data', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS aml_data JSONB DEFAULT '{}'::jsonb;" },
      // Live parse progress tracker
      { col: 'parse_progress', sql: "ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS parse_progress JSONB DEFAULT '{}'::jsonb;" }
    ];

    for (const check of columnChecks) {
      try {
        await pool.query(check.sql);
      } catch (err) {
        console.log(`[migrate] Note on ${check.col}:`, err.message.substring(0, 60));
      }
    }

    // Create indexes
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_internal ON deal_submissions(internal_status);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_assigned ON deal_submissions(assigned_to);`);
    } catch (err) {
      console.log('[migrate] Index creation note:', err.message.substring(0, 80));
    }

    // Fix deal_stage and status constraints
    try {
      await pool.query(`ALTER TABLE deal_submissions ALTER COLUMN deal_stage SET DEFAULT 'received';`);
      await pool.query(`UPDATE deal_submissions SET deal_stage = 'received' WHERE deal_stage = 'dip' OR deal_stage IS NULL;`);
    } catch (err) {
      console.log('[migrate] Note on deal_stage fix:', err.message.substring(0, 60));
    }

    try {
      await pool.query(`ALTER TABLE deal_submissions ALTER COLUMN loan_purpose TYPE TEXT;`);
    } catch (err) {
      console.log('[migrate] Note on loan_purpose:', err.message.substring(0, 60));
    }

    try {
      await pool.query(`ALTER TABLE deal_submissions DROP CONSTRAINT IF EXISTS deal_submissions_status_check;`);
      await pool.query(`ALTER TABLE deal_submissions ADD CONSTRAINT deal_submissions_status_check
        CHECK (status IN ('received','assigned','dip_issued','info_gathering','ai_termsheet','fee_pending','fee_paid','underwriting','bank_submitted','bank_approved','borrower_accepted','legal_instructed','completed','declined','withdrawn'));`);
    } catch (err) {
      console.log('[migrate] Note on deal status constraint:', err.message.substring(0, 80));
    }

    // Support 'draft' stage for deals created via filing cabinet
    try {
      // Ensure deal_stage column accepts 'draft' — no constraint exists so just ensure NULL/received default is fine
      // New deals from smart-parse will explicitly set deal_stage = 'draft'
      console.log('[migrate] Draft stage support ready (no constraint to alter — deal_stage is unconstrained VARCHAR)');
    } catch (err) {
      console.log('[migrate] Note on draft stage:', err.message.substring(0, 60));
    }

    // Financial schedules table — assets, liabilities, income, expenses line items
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_financials (
        id              SERIAL PRIMARY KEY,
        deal_id         INT           REFERENCES deal_submissions(id) ON DELETE CASCADE,
        category        VARCHAR(20)   NOT NULL CHECK (category IN ('asset','liability','income','expense')),
        description     VARCHAR(500)  NOT NULL,
        amount          NUMERIC(15,2),
        frequency       VARCHAR(20)   DEFAULT 'one_off' CHECK (frequency IN ('one_off','monthly','quarterly','annual')),
        holder          VARCHAR(200),
        reference       VARCHAR(200),
        notes           TEXT,
        supporting_doc_id INT,
        source          VARCHAR(30)   DEFAULT 'manual' CHECK (source IN ('manual','parsed')),
        created_by      INT           REFERENCES users(id),
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_financials_deal ON deal_financials(deal_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_financials_cat ON deal_financials(category);`);

    // ── Companies House role verification columns on deal_borrowers ──
    try {
      await pool.query(`ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS ch_matched_role VARCHAR(50)`);
      await pool.query(`ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS ch_match_confidence VARCHAR(20)`);
      await pool.query(`ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS ch_verified_by INT REFERENCES users(id)`);
      await pool.query(`ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS ch_verified_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS ch_match_data JSONB DEFAULT '{}'::jsonb`);
    } catch (err) {
      console.log('[migrate] Note on CH borrower columns:', err.message.substring(0, 60));
    }

    // ── Unique constraint on deal_borrowers to prevent duplicate names per deal ──
    try {
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_borrowers_unique_name ON deal_borrowers(deal_id, LOWER(TRIM(full_name)))`);
      console.log('[migrate] ✓ deal_borrowers unique name constraint');
    } catch (err) {
      console.log('[migrate] Note on borrower unique constraint:', err.message.substring(0, 80));
    }

    // ── 2026-04-19: Split unique name constraint to allow same person under different parents ──
    // The old single index blocked legitimate cases like Sohal Balbinder Singh being director
    // of BOTH Cohort Capital Ltd AND Cohort Capital Holdings Ltd in the same deal.
    // Replace with two partial indexes:
    //   (a) top-level parties (parent_borrower_id IS NULL): name unique per deal
    //   (b) children: name unique per (deal, parent) — same person under different parents allowed
    try {
      await pool.query(`DROP INDEX IF EXISTS idx_deal_borrowers_unique_name`);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_borrowers_unique_name_toplevel
        ON deal_borrowers(deal_id, LOWER(TRIM(full_name)))
        WHERE parent_borrower_id IS NULL
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_borrowers_unique_name_child
        ON deal_borrowers(deal_id, parent_borrower_id, LOWER(TRIM(full_name)))
        WHERE parent_borrower_id IS NOT NULL
      `);
      console.log('[migrate] ✓ deal_borrowers unique name split (toplevel + child-by-parent)');
    } catch (err) {
      console.log('[migrate] Note on split unique name index:', err.message.substring(0, 120));
    }

    // ── Expand borrower role options: add ubo, psc, shareholder ──
    try {
      await pool.query(`ALTER TABLE deal_borrowers DROP CONSTRAINT IF EXISTS deal_borrowers_role_check`);
      await pool.query(`ALTER TABLE deal_borrowers ADD CONSTRAINT deal_borrowers_role_check CHECK (role IN ('primary','joint','guarantor','director','ubo','psc','shareholder'))`);
      console.log('[migrate] ✓ deal_borrowers role constraint updated');
    } catch (err) {
      console.log('[migrate] Note on borrower role constraint:', err.message.substring(0, 80));
    }

    // ── Company Verifications (Companies House API audit trail) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS company_verifications (
        id                SERIAL PRIMARY KEY,
        company_number    VARCHAR(20)   NOT NULL UNIQUE,
        company_name      VARCHAR(300),
        company_status    VARCHAR(50),
        risk_score        VARCHAR(20),
        risk_flags        JSONB         DEFAULT '[]',
        verification_data JSONB         DEFAULT '{}',
        verified_by       INT           REFERENCES users(id),
        verified_at       TIMESTAMPTZ   DEFAULT NOW(),
        created_at        TIMESTAMPTZ   DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_company_verif_number ON company_verifications(company_number);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_company_verif_risk ON company_verifications(risk_score);`);

    // ── Individual person fields on deal_borrowers (KYC, compliance, credit) ──
    const personColumns = [
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS gender VARCHAR(10)`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS id_type VARCHAR(30)`,            // passport, driving_licence, national_id
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS id_number VARCHAR(50)`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS id_expiry DATE`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS residential_address TEXT`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS address_proof_status VARCHAR(20) DEFAULT 'not_obtained'`,  // not_obtained, obtained, verified
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS credit_score INT`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS credit_score_source VARCHAR(30)`, // Experian, Equifax, TransUnion
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS credit_score_date DATE`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS ccj_count INT DEFAULT 0`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS bankruptcy_status VARCHAR(20) DEFAULT 'none'`,  // none, discharged, active, undischarged
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS pep_status VARCHAR(20) DEFAULT 'not_screened'`, // not_screened, clear, flagged
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS sanctions_status VARCHAR(20) DEFAULT 'not_screened'`, // not_screened, clear, flagged
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS source_of_wealth TEXT`,
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS source_of_funds TEXT`,
      // G5.3 — Personal Guarantee election per guarantor (2026-04-20)
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS pg_status VARCHAR(20)`,                     // NULL | 'required' | 'waived' | 'limited' (default changed to NULL 2026-04-21)
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS pg_limit_amount NUMERIC(15,2)`,             // set when pg_status='limited'
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS pg_notes TEXT`,                             // reasoning for waive/limit
      // ── 2026-04-21 ── Fix DEFAULT: was 'required' which incorrectly flagged
      // every CH-discovered director/PSC as a Personal Guarantor. Drop the
      // default so pg_status is NULL unless the broker explicitly ticks PG.
      `ALTER TABLE deal_borrowers ALTER COLUMN pg_status DROP DEFAULT`,
      `UPDATE deal_borrowers SET pg_status = NULL WHERE role IN ('director', 'psc') AND pg_status = 'required'`
    ];
    for (const sql of personColumns) {
      try { await pool.query(sql); } catch (e) { /* column may already exist */ }
    }
    console.log('[migrate] ✓ deal_borrowers individual person columns added');

    // G5.3 — Per-property security charge + existing encumbrance notes (2026-04-20)
    const propertySecurityColumns = [
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS security_charge_type VARCHAR(30) DEFAULT 'first_charge'`, // 'first_charge' | 'second_charge' | 'third_charge' | 'no_charge'
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS existing_charges_note TEXT`                                 // free text until HMLR integration lands
    ];
    for (const sql of propertySecurityColumns) {
      try { await pool.query(sql); } catch (e) { /* column may already exist */ }
    }
    console.log('[migrate] ✓ deal_properties security columns added');

    // ── Hierarchical parent linkage on deal_borrowers (Phase G: Borrower+Guarantor architecture) ──
    // parent_borrower_id points to the top-level party this person belongs to.
    // Top-level parties (primary borrower, corporate guarantor, individual guarantor) have parent_borrower_id = NULL.
    // Directors / PSCs / UBOs have parent_borrower_id set to their corporate parent's id.
    // ON DELETE CASCADE — removing a corporate party removes its nested officers.
    const borrowerHierarchyColumns = [
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS parent_borrower_id INT`,
      `CREATE INDEX IF NOT EXISTS idx_deal_borrowers_parent ON deal_borrowers(parent_borrower_id)`
    ];
    for (const sql of borrowerHierarchyColumns) {
      try { await pool.query(sql); } catch (e) { /* already exists */ }
    }
    // FK + self-reference check — separate so re-runs don't fail if already applied
    try {
      await pool.query(`ALTER TABLE deal_borrowers DROP CONSTRAINT IF EXISTS deal_borrowers_parent_fk`);
      await pool.query(`ALTER TABLE deal_borrowers ADD CONSTRAINT deal_borrowers_parent_fk FOREIGN KEY (parent_borrower_id) REFERENCES deal_borrowers(id) ON DELETE CASCADE`);
    } catch (e) { console.warn('[migrate] parent_borrower_id FK:', e.message); }
    try {
      await pool.query(`ALTER TABLE deal_borrowers DROP CONSTRAINT IF EXISTS deal_borrowers_parent_not_self`);
      await pool.query(`ALTER TABLE deal_borrowers ADD CONSTRAINT deal_borrowers_parent_not_self CHECK (parent_borrower_id IS NULL OR parent_borrower_id <> id)`);
    } catch (e) { console.warn('[migrate] parent_not_self check:', e.message); }
    console.log('[migrate] ✓ deal_borrowers parent_borrower_id column + FK + index added');

    // ── Property search data columns on deal_properties ──
    const propertySearchColumns = [
      // Postcode lookup
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS region VARCHAR(50)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS country VARCHAR(30)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS local_authority VARCHAR(100)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS admin_ward VARCHAR(100)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,6)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,6)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS in_england_or_wales BOOLEAN`,
      // EPC data
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_rating VARCHAR(2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_score INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_potential_rating VARCHAR(2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_floor_area NUMERIC(10,2)`,  // sq metres
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_property_type VARCHAR(50)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_built_form VARCHAR(50)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_construction_age VARCHAR(50)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_habitable_rooms INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_inspection_date DATE`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_certificate_id VARCHAR(100)`,
      // Price paid
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS last_sale_price NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS last_sale_date DATE`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS price_paid_data JSONB DEFAULT '[]'::jsonb`,
      // Search metadata
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS property_search_data JSONB DEFAULT '{}'::jsonb`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS property_searched_at TIMESTAMPTZ`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS property_searched_by INT`,
      // Verification (Phase 2): analyst accepts the EPC match and locks the record
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS property_verified_at TIMESTAMPTZ`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS property_verified_by INT`,
      // Tracks which EPC alternative was manually selected (empty for auto-match)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_selected_lmk_key VARCHAR(100)`,

      // ═══ Chimnie Property Intelligence API (2026-04-21) ═══
      // ~20 flat indexed columns for fast matrix rendering + SQL filtering.
      // Full ~300-field payload lives in chimnie_data JSONB below — query via
      // `->` operators when a column we didn't promote is needed for underwriting.
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_uprn VARCHAR(20)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_exact_match BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_classification VARCHAR(30)`,      // Residential/Commercial/Dual Use/Parent Shell/Other
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_property_type VARCHAR(30)`,       // Terraced/Semi-detached/Detached/Apartment/Maisonette/Other
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_property_subtype VARCHAR(60)`,    // e.g. 'Ground floor apartment'
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_region VARCHAR(40)`,              // London, South East, etc.
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_postcode VARCHAR(12)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_bedrooms INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_bathrooms INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_floor_area_sqm NUMERIC(10,2)`,
      // Valuation
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avm_mid NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avm_low NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avm_high NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avm_confidence VARCHAR(10)`,       // High/Medium/Low
      // 2026-04-27 — AVM model-disagreement detector. Chimnie returns two
      // independent valuations: property_value (sales-comp model) → mid, and
      // property_value_range (hedonic confidence band) → [low, high]. The two
      // models occasionally disagree, leaving mid outside [low,high]. We
      // surface this on the matrix and ship to the risk LLM so IA can be
      // downgraded when the AVM models disagree. Generated columns = no
      // backfill, no race, single source of truth.
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avm_inconsistent BOOLEAN
         GENERATED ALWAYS AS (
           CASE
             WHEN chimnie_avm_low IS NULL OR chimnie_avm_mid IS NULL OR chimnie_avm_high IS NULL THEN NULL
             ELSE (chimnie_avm_mid > chimnie_avm_high OR chimnie_avm_mid < chimnie_avm_low)
           END
         ) STORED`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avm_disagreement_pct NUMERIC(6,2)
         GENERATED ALWAYS AS (
           CASE
             WHEN chimnie_avm_mid IS NULL OR chimnie_avm_high IS NULL OR chimnie_avm_low IS NULL THEN NULL
             WHEN chimnie_avm_mid > chimnie_avm_high AND chimnie_avm_high > 0
               THEN ROUND(100.0 * (chimnie_avm_mid - chimnie_avm_high) / chimnie_avm_high, 2)
             WHEN chimnie_avm_mid < chimnie_avm_low  AND chimnie_avm_mid  > 0
               THEN ROUND(100.0 * (chimnie_avm_low  - chimnie_avm_mid)  / chimnie_avm_mid,  2)
             ELSE 0
           END
         ) STORED`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_last_sale_price NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_last_sale_date DATE`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_years_owned INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_rental_pcm NUMERIC(10,2)`,
      // Ownership (lending-critical)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_lease_type VARCHAR(20)`,          // freehold/leasehold
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_overseas_ownership BOOLEAN`,      // RED FLAG
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_company_ownership BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_occupancy_status VARCHAR(30)`,
      // Building attributes (UW gates)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_is_listed BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_construction_material VARCHAR(20)`,// Brick/Stone/Timber
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_date_of_construction INT`,         // year
      // Flood risk (lending-critical — Daksfirst policy has a flood gate)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_flood_risk_rivers_sea NUMERIC(6,3)`,   // % probability/year
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_flood_risk_surface_water NUMERIC(6,3)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_flood_risk_surface_cat VARCHAR(20)`,    // No Risk/Buildings/Grounds
      // Crime
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_crime_percentile_total NUMERIC(5,2)`,    // higher = fewer crimes
      // Bills
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_council_tax_band VARCHAR(5)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_epc_current VARCHAR(5)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_epc_potential VARCHAR(5)`,
      // Rebuild cost (for insurance reinstatement clause)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_rebuild_cost_estimate NUMERIC(15,2)`,
      // Transit (2026-04-21) — nearest train/TFL station (Chimnie) + PTAL (TfL)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_station_name VARCHAR(120)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_station_distance_m INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_ptal VARCHAR(5)`,  // '0','1a','1b','2','3','4','5','6a','6b' or NULL for non-London

      // ═══ Area Intelligence (2026-04-21) ═══
      // Surrounds this property's neighbourhood, NOT the property itself. Drives
      // the separate "Area Intelligence" panel (market velocity, wealth, schools,
      // planning constraints). All columns queryable; full nested census data
      // stays in chimnie_data JSONB.

      // Location
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_local_authority VARCHAR(100)`,    // e.g. "Hammersmith and Fulham"
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_postcode_district VARCHAR(10)`,    // e.g. "W6"
      // Sales market velocity (exit-via-sale viability)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_area_sales_12m INT`,               // sales in postcode district last 12m
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_area_sales_yoy INT`,               // change in 12m sales volume
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_area_price_per_sqft NUMERIC(10,2)`,// avg £/sqft for this property type in area
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_area_days_to_sell INT`,            // avg days on market
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_area_avg_years_owned NUMERIC(5,2)`,// avg holding period (50y rolling)
      // Rental market velocity (BTL exit viability)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_area_days_to_rent INT`,            // avg void period
      // Wealth percentiles — higher = wealthier
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_wealth_pct_national NUMERIC(5,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_wealth_pct_local_authority NUMERIC(5,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_wealth_pct_postcode_district NUMERIC(5,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_total_hhi_msoa INT`,               // MSOA total household income (£/yr)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_disposable_hhi_msoa INT`,          // MSOA disposable household income (£/yr)
      // Schools (nearest primary + best nearby secondary)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_primary_name VARCHAR(200)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_primary_distance_m INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_primary_ofsted VARCHAR(30)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_best_secondary_name VARCHAR(200)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_best_secondary_distance_m INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_best_secondary_ofsted VARCHAR(30)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_best_secondary_att8 NUMERIC(5,2)`, // GCSE attainment8 score
      // Planning constraints (affect exit options — redevelopment / extension / conversion)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_green_belt BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_aonb BOOLEAN`,                  // Area of Outstanding Natural Beauty
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_near_historic_landfill BOOLEAN`,   // contamination risk
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_coal_mining_area BOOLEAN`,      // subsidence / stability
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_world_heritage BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_sssi_affected BOOLEAN`,            // Site of Special Scientific Interest
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_scheduled_monument_affected BOOLEAN`,
      // 5-year value trajectory (% change computed from historical_property_values in JSONB)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_5y_value_change_pct NUMERIC(6,2)`,
      // Urban/rural classifier (area demographic proxy)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_is_urban BOOLEAN`,

      // ═══ Chimnie Tier 1+2 (2026-04-21) — additional high-signal fields ═══
      // Sale/ownership signals
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_sale_propensity VARCHAR(15)`,       // '<1y','1-2y','2-5y','5-10y','10+y'
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_avg_proximal_value NUMERIC(15,2)`,  // avg value of comps in postcode
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_estimated_listing_value NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_prebuild BOOLEAN`,                   // planning granted, not built — HARD DECLINE
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_has_farmland BOOLEAN`,              // HARD DECLINE — agricultural
      // Flat-specific
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_flat_storey_count INT`,             // storeys in the block
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_estimated_floor_level INT`,         // which floor this flat is on
      // Outdoor value-add
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_has_garden BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_grounds_area_sqm NUMERIC(10,2)`,
      // Subsidence / tree hazard (climate + structural risk)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_subsidence_risk_2030 VARCHAR(20)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_subsidence_risk_2050 VARCHAR(20)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_subsidence_risk_2080 VARCHAR(20)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_tree_hazard_index NUMERIC(6,3)`,    // tree_fall risk within 10m
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_closest_tree_distance_m NUMERIC(6,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_closest_tree_height_m NUMERIC(6,2)`,
      // Radon — health/disclosure liability
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_radon_affected BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_radon_protection_level VARCHAR(40)`,
      // Flood context (beyond the % probability)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_distance_from_coast_m INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_distance_from_river_m INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_elevation_min_m NUMERIC(7,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_elevation_max_m NUMERIC(7,2)`,
      // Noise (residential re-sale signal)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_noise_road_db NUMERIC(5,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_noise_rail_db NUMERIC(5,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_noise_air_db NUMERIC(5,2)`,
      // Additional planning constraints
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_ancient_woodland BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_common_land BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_in_historic_parks BOOLEAN`,
      // University proximity (student BTL context)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_university_name VARCHAR(200)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_nearest_university_distance_m INT`,
      // Rebuild cost by finish tier (insurance strategy)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_rebuild_cost_basic NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_rebuild_cost_modern NUMERIC(15,2)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_rebuild_cost_luxury NUMERIC(15,2)`,
      // Connected property risk (for multi-unit / parent-flat deals)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_connected_property_risk VARCHAR(40)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_parent_uprn VARCHAR(20)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_sibling_uprn_count INT`,             // how many flats share our parent_uprn
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_subproperty_uprn_count INT`,        // how many subproperties we ourselves contain

      // ═══ Chimnie Tier 3 (2026-04-21) — images, EPC retrofit, heating, extensions, solar, outbuildings ═══
      // Images — URLs to listing + floorplan images hosted by Chimnie's source portals
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_listing_image_url TEXT`,             // first listing image URL (legacy — still populated)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_floorplan_image_url TEXT`,           // first floorplan URL (legacy)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_image_count INT`,                    // total listing images available
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_floorplan_count INT`,
      // 2026-04-21: store up to 12 listing URLs + 4 floorplan URLs so we can render a strip
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_listing_image_urls JSONB`,           // array of listing image URLs (up to 12)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_floorplan_image_urls JSONB`,         // array of floorplan URLs (up to 4)
      // EPC retrofit recommendations (MEES compliance path)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_epc_recommendations JSONB`,          // array of {description, cost, co2_saving, ...}
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_environment_impact_current INT`,     // rating A-G as number (A=100, G=1)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_environment_impact_potential INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_co2_emissions_current NUMERIC(8,2)`, // tonnes CO2 per year
      // Heating
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_main_fuel VARCHAR(60)`,              // e.g. 'mains gas', 'electricity', 'oil', 'LPG'
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_primary_heating_source VARCHAR(200)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_heating_types JSONB`,                // array of heating_types enum
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_has_mains_gas BOOLEAN`,
      // Extensions (legal-due-diligence flag)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_has_extension BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_extension_count INT`,
      // Insurance: fire station distance (material premium driver)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_fire_station_distance_m INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_fire_station_name VARCHAR(120)`,
      // Solar (green credentials, EPC uplift)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_has_solar_panels BOOLEAN`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_solar_panels_shared BOOLEAN`,
      // Outbuildings (annex / garden office — 15-25% of value contribution)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_outbuildings_count INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_outbuildings_area_sqm NUMERIC(10,2)`,
      // Rooms (richer layout picture)
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_reception_rooms INT`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_total_rooms INT`,
      // 5-year historical values — compact array of monthly values for sparkline rendering
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_historical_values_compact JSONB`,    // array of ~60 numbers, shape [v0, v1, ..., v59]
      // Full payload + audit
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_data JSONB DEFAULT '{}'::jsonb`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_fetched_at TIMESTAMPTZ`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_fetched_by INT REFERENCES users(id)`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_credits_used INT DEFAULT 0`,
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS chimnie_lookup_method VARCHAR(20)`  // 'address'|'uprn'
    ];
    for (const sql of propertySearchColumns) {
      try { await pool.query(sql); } catch (e) { /* column may already exist */ }
    }
    console.log('[migrate] ✓ deal_properties property search columns added');

    // ═══════════════════════════════════════════════════════════════════
    // G5.3 Path 2 — Backfill legacy deals into deal_borrowers (2026-04-20)
    // For each deal_submissions row that has borrower_company (or borrower_name)
    // but no matching role='primary' in deal_borrowers, create:
    //   1. A primary borrower row (corporate if company_number, else individual)
    //   2. A child PSC officer row for the UBO if borrower_name is present + distinct
    //      (so the matrix Security section renders Alessandra etc. as real editable rows)
    // Idempotent via WHERE NOT EXISTS / LEFT JOIN IS NULL — safe to re-run.
    // ═══════════════════════════════════════════════════════════════════
    try {
      // Step 1 — Insert primary borrower for legacy deals that don't have one yet.
      // Guards against duplicates: skip if ANY top-level row already matches by company_number
      // OR by full_name (case-insensitive). Prevents creating a second Gold Medal when it
      // already exists as role='joint' or under a different full_name spelling.
      const primaryInsertResult = await pool.query(`
        INSERT INTO deal_borrowers (deal_id, role, full_name, borrower_type, company_name, company_number,
                                    email, phone, nationality, address, kyc_status, created_at, updated_at)
        SELECT
          ds.id,
          'primary',
          COALESCE(ds.borrower_company, ds.borrower_name),
          CASE WHEN COALESCE(ds.borrower_company, ds.company_number) IS NOT NULL THEN 'corporate' ELSE 'individual' END,
          ds.borrower_company,
          ds.company_number,
          ds.borrower_email,
          ds.borrower_phone,
          ds.borrower_nationality,
          NULL,
          'pending',
          NOW(),
          NOW()
        FROM deal_submissions ds
        WHERE (ds.borrower_company IS NOT NULL OR ds.borrower_name IS NOT NULL)
          AND ds.id IS NOT NULL
          AND NOT EXISTS (
            -- Skip if ANY existing top-level row matches by company_number OR by full_name
            SELECT 1 FROM deal_borrowers db
            WHERE db.deal_id = ds.id
              AND db.parent_borrower_id IS NULL
              AND (
                (db.company_number IS NOT NULL AND db.company_number = ds.company_number)
                OR LOWER(TRIM(db.full_name)) = LOWER(TRIM(COALESCE(ds.borrower_company, ds.borrower_name)))
                OR LOWER(TRIM(db.company_name)) = LOWER(TRIM(COALESCE(ds.borrower_company, '')))
              )
          )
        RETURNING id, deal_id
      `);
      const newPrimariesCount = primaryInsertResult.rows.length;
      console.log(`[migrate] ✓ G5.3 Path 2: backfilled ${newPrimariesCount} legacy primary borrower row(s)`);

      // Step 2 — Insert UBO child PSC for ANY corporate top-level row (primary OR joint)
      // that matches the deal's borrower_company/company_number, if no matching UBO exists yet.
      // Runs regardless of whether Step 1 inserted anything — handles the case where
      // corporate row was created manually (e.g. as role='joint') without its UBO.
      const uboInsertResult = await pool.query(`
        INSERT INTO deal_borrowers (deal_id, role, full_name, borrower_type, nationality, email,
                                    parent_borrower_id, ch_match_data, ch_matched_role, kyc_status,
                                    pg_status, created_at, updated_at)
        SELECT
          ds.id,
          'psc',
          ds.borrower_name,
          'individual',
          ds.borrower_nationality,
          ds.borrower_email,
          db_corp.id,
          '{"is_psc": true, "officer_role": "Ultimate Beneficial Owner"}'::jsonb,
          'UBO',
          'pending',
          'required',
          NOW(),
          NOW()
        FROM deal_submissions ds
        INNER JOIN deal_borrowers db_corp
          ON db_corp.deal_id = ds.id
          AND db_corp.parent_borrower_id IS NULL
          AND db_corp.borrower_type = 'corporate'
          AND (
            (db_corp.company_number IS NOT NULL AND db_corp.company_number = ds.company_number)
            OR LOWER(TRIM(db_corp.full_name)) = LOWER(TRIM(COALESCE(ds.borrower_company, '')))
          )
          AND db_corp.role IN ('primary', 'joint')
        WHERE ds.borrower_name IS NOT NULL
          AND ds.borrower_name <> ''
          AND ds.borrower_name <> COALESCE(ds.borrower_company, '')
          AND NOT EXISTS (
            -- Skip if ANY child of this corporate already has a matching name
            SELECT 1 FROM deal_borrowers db2
            WHERE db2.parent_borrower_id = db_corp.id
              AND LOWER(TRIM(db2.full_name)) = LOWER(TRIM(ds.borrower_name))
          )
        RETURNING id, parent_borrower_id
      `);
      console.log(`[migrate] ✓ G5.3 Path 2: backfilled ${uboInsertResult.rows.length} UBO officer row(s)`);

      // Step 3 — Reclassify existing PSCs: if ch_match_data.psc_kind says corporate-entity
      // or legal-person, set borrower_type='corporate'. Fixes data ingested before the
      // routes/borrowers.js fix that derives borrower_type from kind.
      const reclassifyResult = await pool.query(`
        UPDATE deal_borrowers
        SET borrower_type = 'corporate', updated_at = NOW()
        WHERE role = 'psc'
          AND borrower_type = 'individual'
          AND ch_match_data IS NOT NULL
          AND (
            LOWER(ch_match_data->>'psc_kind') LIKE '%corporate-entity%'
            OR LOWER(ch_match_data->>'psc_kind') LIKE '%legal-person%'
          )
        RETURNING id, full_name
      `);
      if (reclassifyResult.rows.length > 0) {
        console.log(`[migrate] ✓ G5.3 Path 2 Step 3: reclassified ${reclassifyResult.rows.length} corporate PSC(s) to borrower_type='corporate'`);
      }
    } catch (err) {
      console.error('[migrate] G5.3 Path 2 backfill failed:', err.message);
      // Don't rethrow — a backfill failure shouldn't prevent server start
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Matrix-SSOT for DIP — 2026-04-20 (Session M1)
    //  Locks Matrix as the canonical data surface. DIP form becomes approval-gates only.
    //  New columns on deal_submissions:
    //    - Requested/Approved pairs for negotiable terms (broker asks vs what we offer)
    //    - New fee columns: dip_fee (flat £1k default), exit_fee_pct, extension_fee_pct
    //    - Per-section DIP approval stamps (5 sections) so Issue DIP is gated on
    //      RM ✓ of each section, with auto-revoke on matrix edit
    //  Backfill: existing deals copy loan_amount→loan_amount_approved etc. so no deal
    //    is left with NULL approved values on rollout.
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      const ssotCols = [
        // Requested/Approved pairs — "approved" columns are what the matrix edits and
        // what generators read. "Requested" is captured at submission for audit and
        // the Matrix "Requested vs Approved" display.
        'ADD COLUMN IF NOT EXISTS loan_amount_requested NUMERIC(15,2)',
        'ADD COLUMN IF NOT EXISTS loan_amount_approved NUMERIC(15,2)',
        'ADD COLUMN IF NOT EXISTS ltv_approved NUMERIC(5,2)',
        'ADD COLUMN IF NOT EXISTS rate_approved NUMERIC(5,3)',
        'ADD COLUMN IF NOT EXISTS term_months_requested INT',
        'ADD COLUMN IF NOT EXISTS term_months_approved INT',
        'ADD COLUMN IF NOT EXISTS interest_servicing_requested VARCHAR(30)',
        'ADD COLUMN IF NOT EXISTS interest_servicing_approved VARCHAR(30)',
        'ADD COLUMN IF NOT EXISTS exit_strategy_requested TEXT',
        'ADD COLUMN IF NOT EXISTS exit_strategy_approved TEXT',
        // New fee columns
        'ADD COLUMN IF NOT EXISTS dip_fee NUMERIC(10,2) DEFAULT 1000',
        'ADD COLUMN IF NOT EXISTS exit_fee_pct NUMERIC(5,2) DEFAULT 1.00',
        'ADD COLUMN IF NOT EXISTS extension_fee_pct NUMERIC(5,2) DEFAULT 1.00',
        // Per-section DIP approval state — each section has {approved, by, at}
        // Auto-revoke triggered when any referenced matrix field changes (app-layer logic).
        'ADD COLUMN IF NOT EXISTS dip_borrower_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_borrower_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_borrower_approved_at TIMESTAMPTZ',
        'ADD COLUMN IF NOT EXISTS dip_security_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_security_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_security_approved_at TIMESTAMPTZ',
        'ADD COLUMN IF NOT EXISTS dip_loan_terms_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_loan_terms_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_loan_terms_approved_at TIMESTAMPTZ',
        'ADD COLUMN IF NOT EXISTS dip_fees_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_fees_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_fees_approved_at TIMESTAMPTZ',
        'ADD COLUMN IF NOT EXISTS dip_conditions_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_conditions_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_conditions_approved_at TIMESTAMPTZ',
        // M4d (Matrix-SSOT 2026-04-20): Use of Funds + Exit Strategy become their
        // own approval gates. Rationale: RM must understand purpose + exit BEFORE
        // pricing loan terms. Commercially correct ordering.
        'ADD COLUMN IF NOT EXISTS dip_use_of_funds_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_use_of_funds_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_use_of_funds_approved_at TIMESTAMPTZ',
        'ADD COLUMN IF NOT EXISTS dip_exit_strategy_approved BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS dip_exit_strategy_approved_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_exit_strategy_approved_at TIMESTAMPTZ',
        // Credit Decision gate (hybrid — Credit approves on same DIP form when required)
        'ADD COLUMN IF NOT EXISTS dip_credit_decision VARCHAR(20)', // approved | declined | more_info | null
        'ADD COLUMN IF NOT EXISTS dip_credit_decided_by INT REFERENCES users(id)',
        'ADD COLUMN IF NOT EXISTS dip_credit_decided_at TIMESTAMPTZ',
        'ADD COLUMN IF NOT EXISTS dip_credit_notes TEXT'
      ];
      for (const frag of ssotCols) {
        await pool.query(`ALTER TABLE deal_submissions ${frag}`);
      }
      console.log('[migrate] ✓ Matrix-SSOT columns on deal_submissions');

      // Backfill approved columns from existing values so legacy deals have non-null data
      await pool.query(`
        UPDATE deal_submissions
        SET loan_amount_approved = COALESCE(loan_amount_approved, loan_amount),
            loan_amount_requested = COALESCE(loan_amount_requested, loan_amount),
            ltv_approved = COALESCE(ltv_approved, ltv_requested),
            rate_approved = COALESCE(rate_approved, rate_requested),
            term_months_approved = COALESCE(term_months_approved, term_months),
            term_months_requested = COALESCE(term_months_requested, term_months),
            interest_servicing_approved = COALESCE(interest_servicing_approved, interest_servicing),
            interest_servicing_requested = COALESCE(interest_servicing_requested, interest_servicing),
            exit_strategy_approved = COALESCE(exit_strategy_approved, exit_strategy),
            exit_strategy_requested = COALESCE(exit_strategy_requested, exit_strategy)
        WHERE loan_amount_approved IS NULL OR ltv_approved IS NULL OR rate_approved IS NULL
      `);
      console.log('[migrate] ✓ Matrix-SSOT backfill — existing deals have approved values set');
    } catch (err) {
      console.log('[migrate] Note on Matrix-SSOT columns:', err.message.substring(0, 120));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Delegated Authority — 2026-04-20 (Session 1a)
    //  admin_config: single-row config table for auto-routing thresholds + toggles
    //  deal_submissions: 3 columns to record the auto-route decision
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_config (
          id                          SERIAL PRIMARY KEY,
          auto_approve_enabled        BOOLEAN       DEFAULT true,
          auto_approve_max_loan       NUMERIC(15,2) DEFAULT 1000000,
          auto_approve_max_ltv_pct    NUMERIC(5,2)  DEFAULT 65.00,
          auto_approve_asset_types    TEXT[]        DEFAULT ARRAY['residential']::TEXT[],
          updated_at                  TIMESTAMPTZ   DEFAULT NOW(),
          updated_by                  INT REFERENCES users(id)
        )
      `);
      // Seed the single-row config if empty; id=1 always
      await pool.query(`
        INSERT INTO admin_config (id, auto_approve_enabled, auto_approve_max_loan, auto_approve_max_ltv_pct, auto_approve_asset_types)
        VALUES (1, true, 1000000, 65.00, ARRAY['residential']::TEXT[])
        ON CONFLICT (id) DO NOTHING
      `);
      console.log('[migrate] ✓ admin_config table (Delegated Authority)');
    } catch (err) {
      console.log('[migrate] Note on admin_config:', err.message.substring(0, 100));
    }

    // ── llm_model_config: admin-editable Anthropic model selection per call type
    //   Read by the V5 Credit Analysis n8n canvas at workflow start.
    //   Editable via /admin/models.html → PUT /api/admin/config/llm-config/:callType
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS llm_model_config (
          call_type      TEXT PRIMARY KEY,
          model          TEXT NOT NULL,
          max_tokens     INT  NOT NULL,
          temperature    NUMERIC(3,2) DEFAULT 0.00,
          budget_gbp     NUMERIC(6,2) DEFAULT 5.00,
          enabled        BOOLEAN DEFAULT TRUE,
          notes          TEXT,
          updated_by     INT REFERENCES users(id),
          updated_at     TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Seed 6 canonical call types. ON CONFLICT DO NOTHING — never overwrite
      // admin-edited values on redeploy.
      await pool.query(`
        INSERT INTO llm_model_config (call_type, model, max_tokens, temperature, budget_gbp, notes) VALUES
          ('credit_memo',    'claude-sonnet-4-6',          8000, 0.00, 2.00, 'Call 1 — full credit memo (14 sections)'),
          ('termsheet',      'claude-sonnet-4-6',          6000, 0.00, 1.50, 'Call 2 — indicative term sheet (11 sections)'),
          ('gbb',            'claude-sonnet-4-6',          7000, 0.00, 1.75, 'Call 3 — GB funder placement memo (W1-W10 + B1-B7)'),
          ('financial',      'claude-sonnet-4-6',          5000, 0.00, 1.25, 'Call 4 — financial summary + stress matrix'),
          ('assembled',      'claude-sonnet-4-6',          6000, 0.00, 1.50, 'Call 5 — assembled credit committee briefing'),
          ('briefing_haiku', 'claude-haiku-4-5-20251001',  1500, 0.00, 0.10, 'Optional Haiku one-page narrative briefing')
        ON CONFLICT (call_type) DO NOTHING
      `);

      console.log('[migrate] ✓ llm_model_config table ready (6 call types seeded)');
    } catch (err) {
      console.log('[migrate] Note on llm_model_config:', err.message.substring(0, 120));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  llm_model_config V5.1 (2026-04-25): multi-provider extension
    //  ─────────────────────────────────────────────────────────────────────────
    //  Adds Perplexity + Google as providers alongside Anthropic. Existing
    //  6 Anthropic rows untouched. Perplexity rows carry FCA-defensible domain
    //  allowlists in extra_params (locked in 2026-04-25 review session). Google
    //  rows seeded DISABLED pending NotebookLM API verification 2026-04-26.
    //
    //  Read by V5 n8n canvas via GET /api/admin/config/llm-config (same route).
    //  See memory: project_v5_canvas_drafts_2026_04_25.md
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`ALTER TABLE llm_model_config ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'anthropic'`);
      await pool.query(`ALTER TABLE llm_model_config ADD COLUMN IF NOT EXISTS extra_params JSONB`);
      await pool.query(`ALTER TABLE llm_model_config ADD COLUMN IF NOT EXISTS cost_per_1m_input_usd NUMERIC(10,4)`);
      await pool.query(`ALTER TABLE llm_model_config ADD COLUMN IF NOT EXISTS cost_per_1m_output_usd NUMERIC(10,4)`);

      // Backfill costs on existing Anthropic rows for cost telemetry rollup.
      // Source: Anthropic public pricing as of 2026-04-25.
      // These remain admin-editable; UPDATE only fires when value is NULL.
      await pool.query(`
        UPDATE llm_model_config
           SET cost_per_1m_input_usd  = 3.00,
               cost_per_1m_output_usd = 15.00
         WHERE provider = 'anthropic'
           AND model = 'claude-sonnet-4-6'
           AND cost_per_1m_input_usd IS NULL
      `);
      await pool.query(`
        UPDATE llm_model_config
           SET cost_per_1m_input_usd  = 15.00,
               cost_per_1m_output_usd = 75.00
         WHERE provider = 'anthropic'
           AND model = 'claude-opus-4-6'
           AND cost_per_1m_input_usd IS NULL
      `);
      await pool.query(`
        UPDATE llm_model_config
           SET cost_per_1m_input_usd  = 1.00,
               cost_per_1m_output_usd = 5.00
         WHERE provider = 'anthropic'
           AND model = 'claude-haiku-4-5-20251001'
           AND cost_per_1m_input_usd IS NULL
      `);

      // ── Seed 3 active Perplexity rows + 2 disabled Google placeholders ──
      // Domain allowlists approved 2026-04-25 review session:
      //   pplx_market_evidence  → UK property/sector + hospitality + Wikipedia (context)
      //   pplx_party_screening  → UK + US + EU + global registries + Wikipedia (context)
      //   pplx_quick_facts      → primary sources only (BoE/ONS/gov.uk/FCA/PRA)
      // ON CONFLICT DO NOTHING — never overwrite admin edits on redeploy.
      const PPLX_MARKET = JSON.stringify({
        search_domain_filter: [
          'landregistry.gov.uk', 'gov.uk', 'ons.gov.uk', 'bankofengland.co.uk',
          'rightmove.co.uk', 'zoopla.co.uk', 'onthemarket.com',
          'estatesgazette.com', 'egradius.co.uk', 'propertyweek.com',
          'savills.co.uk', 'knightfrank.co.uk', 'jll.co.uk', 'cbre.co.uk', 'cushmanwakefield.com',
          'ukfinance.org.uk', 'nacfb.org', 'astl.co.uk',
          'str.com', 'hotstats.com', 'hospitalitynet.org',
          'wikipedia.org'
        ],
        search_recency_filter: 'year',
        return_citations: true,
      });
      const PPLX_PARTY = JSON.stringify({
        search_domain_filter: [
          // UK statutory + regulators
          'find-and-update.company-information.service.gov.uk',
          'companieshouse.gov.uk', 'thegazette.co.uk', 'gov.uk',
          'fca.org.uk', 'handbook.fca.org.uk',
          'bailii.org', 'judiciary.uk', 'supremecourt.uk',
          'nationalcrimeagency.gov.uk', 'charitycommission.gov.uk',
          'sanctionssearch.ofac.treas.gov',
          // UK adverse media
          'ft.com', 'reuters.com', 'bloomberg.com', 'bbc.co.uk',
          'thetimes.co.uk', 'telegraph.co.uk', 'theguardian.com',
          'economist.com', 'citywire.com', 'cityam.com',
          // US statutory + regulators + adverse media
          'sec.gov', 'finra.org', 'federalreserve.gov', 'justice.gov',
          'courtlistener.com', 'opencorporates.com',
          'wsj.com', 'nytimes.com', 'forbes.com', 'businessinsider.com',
          // EU statutory + regulators + adverse media
          'europa.eu', 'e-justice.europa.eu', 'eba.europa.eu',
          'esma.europa.eu', 'ecb.europa.eu',
          'bafin.de', 'finma.ch', 'politico.eu', 'handelsblatt.com',
          // Context
          'wikipedia.org',
        ],
        search_recency_filter: 'year',
        return_citations: true,
      });
      const PPLX_FACTS = JSON.stringify({
        search_domain_filter: [
          'bankofengland.co.uk', 'ons.gov.uk', 'gov.uk', 'hmrc.gov.uk',
          'fca.org.uk', 'handbook.fca.org.uk', 'prarulebook.co.uk',
          'legislation.gov.uk',
        ],
        search_recency_filter: 'month',
        return_citations: true,
      });

      await pool.query(`
        INSERT INTO llm_model_config
          (call_type, provider, model, max_tokens, temperature, budget_gbp, enabled, notes, extra_params, cost_per_1m_input_usd, cost_per_1m_output_usd)
        VALUES
          ('pplx_market_evidence',  'perplexity', 'sonar-pro',           3000, 0.20, 0.50, TRUE,
            'Comps, area pricing, lender/sector market — feeds Funder Placement + Credit Memo',
            $1::jsonb, 3.00, 15.00),
          ('pplx_party_screening',  'perplexity', 'sonar-reasoning-pro', 4000, 0.20, 0.75, TRUE,
            'Borrower/director/sponsor adverse media + corporate filings — feeds Borrower + Conditions',
            $2::jsonb, 5.00, 25.00),
          ('pplx_quick_facts',      'perplexity', 'sonar',               1500, 0.10, 0.20, TRUE,
            'SONIA, base rate, regulatory spot-checks — primary sources only',
            $3::jsonb, 1.00, 5.00),
          ('google_doc_synthesis',  'google',     '',                    4000, 0.30, 0.50, FALSE,
            'Document synthesis (NotebookLM/Gemini) — DISABLED pending API verification',
            NULL, NULL, NULL),
          ('google_audio_overview', 'google',     '',                    2000, 0.30, 0.30, FALSE,
            'Audio-style committee briefing summary — DISABLED pending API verification',
            NULL, NULL, NULL)
        ON CONFLICT (call_type) DO NOTHING
      `, [PPLX_MARKET, PPLX_PARTY, PPLX_FACTS]);

      console.log('[migrate] ✓ llm_model_config V5.1: provider+extra_params+cost columns; 5 new rows (3 Perplexity active, 2 Google disabled)');
    } catch (err) {
      console.log('[migrate] Note on llm_model_config V5.1:', err.message.substring(0, 160));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  llm_model_config — Risk MVP seed (2026-04-26): risk_grade row
    //  ─────────────────────────────────────────────────────────────────────────
    //  Drives the n8n Risk Analysis Standalone canvas. Opus 4.6 chosen over
    //  Sonnet for rubric v2 stability while it's still un-battle-tested. Macro
    //  block is sent with cache_control:ephemeral so 90% of input tokens land
    //  on the discount tier (~$1.50/1M cached vs $15/1M fresh). Easy downgrade
    //  to Sonnet later via:
    //    UPDATE llm_model_config SET model='claude-sonnet-4-6'
    //                              , cost_per_1m_input_usd=3.00
    //                              , cost_per_1m_output_usd=15.00
    //     WHERE call_type='risk_grade';
    //
    //  ON CONFLICT DO NOTHING — never overwrite admin-edited values on redeploy.
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`
        INSERT INTO llm_model_config
          (call_type, provider, model, max_tokens, temperature, budget_gbp, enabled, notes, cost_per_1m_input_usd, cost_per_1m_output_usd)
        VALUES
          ('risk_grade', 'anthropic', 'claude-opus-4-6', 25000, 0.00, 5.00, TRUE,
            'V5 Risk Analysis rubric grading — Opus 4.6 + macro-block prompt caching (5-min ephemeral TTL)',
            15.00, 75.00)
        ON CONFLICT (call_type) DO NOTHING
      `);
      console.log('[migrate] ✓ llm_model_config: risk_grade row seeded (Opus 4.6, max_tokens 25000)');
    } catch (err) {
      console.log('[migrate] Note on risk_grade seed:', err.message.substring(0, 160));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  llm_prompts (2026-04-25): admin-editable prompt body store, append-only
    //  versioned. Stores every system/user prompt body the V5 canvas pulls at
    //  workflow start (risk-analysis rubric v2, credit-memo prompt, termsheet
    //  prompt, etc.).
    //
    //  Append-only design:
    //   - Every save is a new row (UNIQUE (prompt_key, version)).
    //   - is_active flags the live version; partial unique index guarantees
    //     exactly one active row per prompt_key.
    //   - Old versions are retained forever for audit / rollback / regrade-under-
    //     prior-rubric. Every risk_view row will reference the (prompt_key,
    //     version) it was graded under.
    //
    //  No body seeding here — bodies are loaded by a follow-on step once the
    //  macro context block v1 is drafted and the rubric v2 file has its final
    //  deployed path. Schema-only migration is safe to ship today.
    //
    //  Read by V5 n8n canvas via GET /api/admin/config/llm-prompt/:key
    //  Edited via /admin/prompts UI (POST creates new version, PATCH flips active).
    //  See memory: project_risk_run_manual_trigger.md
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS llm_prompts (
          id              SERIAL PRIMARY KEY,
          prompt_key      TEXT NOT NULL,
          version         INTEGER NOT NULL,
          body            TEXT NOT NULL,
          is_active       BOOLEAN NOT NULL DEFAULT FALSE,
          description     TEXT,
          parent_version  INTEGER,
          changelog       TEXT,
          edited_by       TEXT NOT NULL DEFAULT 'system',
          edited_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (prompt_key, version)
        )
      `);

      // Partial unique index: at most one active version per prompt_key.
      // Postgres treats NULLs in the WHERE clause correctly; flipping active
      // is a 2-step transaction (UPDATE old → FALSE, UPDATE new → TRUE).
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS llm_prompts_one_active_per_key
          ON llm_prompts (prompt_key) WHERE is_active = TRUE
      `);

      // Lookup index for the canvas hot path: GET /api/admin/config/llm-prompt/:key
      // resolves to "the active row for this key". This index keeps that O(1).
      await pool.query(`
        CREATE INDEX IF NOT EXISTS llm_prompts_key_active_idx
          ON llm_prompts (prompt_key, is_active)
      `);

      console.log('[migrate] ✓ llm_prompts table ready (append-only versioned, no body seed)');
    } catch (err) {
      console.log('[migrate] Note on llm_prompts:', err.message.substring(0, 160));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  risk_view (2026-04-25): append-only run-log of risk-analysis grading.
    //  Every press of "Run Risk Analysis" on /deal/:id writes a fresh row.
    //
    //  Pinning rule (from feedback_matrix_is_canonical + project_risk_run_manual_trigger):
    //   - rubric_prompt_id  → FK into llm_prompts(id), stamps the EXACT (key, version) used
    //   - macro_prompt_id   → same, for the macro context block
    //   - sensitivity_calculator_version → stamps the deterministic JS calculator hash/tag
    //   - data_stage        → 'dip' | 'underwriting' | 'pre_completion'
    //  Together these four make any historical row exactly reproducible.
    //
    //  Append-only: rows never UPDATE except for status transitions
    //  (pending → running → success | failed) and cost telemetry settle.
    //
    //  Indexes:
    //   - (deal_id, triggered_at DESC) → Risk View tab pulls latest + history
    //   - (status) → admin can filter stuck 'running' rows
    //
    //  Read by: GET /api/deals/:id/risk-runs (Risk View tab on apply.daksfirst.com)
    //  Written by: portal trigger route (creates pending row), n8n callback
    //  (settles status + grades + telemetry).
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS risk_view (
          id                              SERIAL PRIMARY KEY,
          deal_id                         INTEGER NOT NULL REFERENCES deal_submissions(id) ON DELETE CASCADE,
          data_stage                      TEXT NOT NULL,
          rubric_prompt_id                INTEGER REFERENCES llm_prompts(id),
          macro_prompt_id                 INTEGER REFERENCES llm_prompts(id),
          sensitivity_calculator_version  TEXT,
          model                           TEXT,
          model_temperature               NUMERIC(3,2),
          model_max_tokens                INTEGER,
          input_payload                   JSONB,
          raw_response                    TEXT,
          parsed_grades                   JSONB,
          input_tokens                    INTEGER,
          output_tokens                   INTEGER,
          cost_gbp                        NUMERIC(8,4),
          latency_ms                      INTEGER,
          status                          TEXT NOT NULL DEFAULT 'pending',
          error_message                   TEXT,
          triggered_by                    TEXT,
          triggered_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at                    TIMESTAMPTZ
        )
      `);

      // Hot-path index for the Risk View tab: latest run + history per deal.
      await pool.query(`
        CREATE INDEX IF NOT EXISTS risk_view_deal_triggered_idx
          ON risk_view (deal_id, triggered_at DESC)
      `);

      // Status filter for admin (find stuck 'running' rows or recent failures).
      await pool.query(`
        CREATE INDEX IF NOT EXISTS risk_view_status_idx
          ON risk_view (status)
      `);

      console.log('[migrate] ✓ risk_view table ready (append-only run-log, FK-pinned to llm_prompts)');
    } catch (err) {
      console.log('[migrate] Note on risk_view:', err.message.substring(0, 160));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Seed llm_prompts with risk_rubric v2 + risk_macro v1 (2026-04-25)
    //  ─────────────────────────────────────────────────────────────────────────
    //  Bodies live as files under daksfirst-auth/prompts/ — diffable in git,
    //  reviewable in PRs, deployed alongside code. Migration reads them ONCE
    //  on first deploy where the (prompt_key, version) row doesn't yet exist
    //  (ON CONFLICT DO NOTHING). Subsequent edits happen via /admin/prompts UI
    //  and create new rows with incrementing version + flipped is_active.
    //
    //  Defensive: if a prompt file is missing on disk, skip the seed for that
    //  key — DO NOT crash auth boot. Missing seed means /admin/prompts UI must
    //  be used to upload v1 manually; risk pipeline won't run until then.
    //
    //  Seeded keys:
    //   - risk_rubric  v2 (parent=NULL — v1 was draft, never stored in DB)
    //   - risk_macro   v1 (NEUTRAL seed — see DRAFTS/v5-canvas-2026-04-25/
    //                       macro-context-block-v1.md for usage notes)
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      const promptsDir = path.join(__dirname, '..', 'prompts');

      const seedRows = [
        {
          file: 'risk_rubric.v2.md',
          prompt_key: 'risk_rubric',
          version: 2,
          parent_version: null,
          description: 'Risk analysis rubric — 9 dimensions, 3-layer output, stage-aware grading',
          changelog:
            'v1 → v2: added borrower credit profile inputs (Experian/Equifax/TransUnion, ' +
            'adverse credit, net worth, personal financials, tax returns); explicit data-stage ' +
            'awareness with expected-data table; expanded Borrower/ALM/Guarantors definitions; ' +
            'stage-aware conservatism rule; mandatory underwriting stage line in output.',
        },
        {
          file: 'risk_macro.v1.md',
          prompt_key: 'risk_macro',
          version: 1,
          parent_version: null,
          description: 'Macro context block — UK bridging market state, themes, posture',
          changelog:
            'v1 seed: NEUTRAL posture with placeholder fields. All numeric fields ' +
            'left as [FILL — source] markers; rubric instructed to treat absent ' +
            'fields as "neutral macro: no themes flagged this cycle". Replace via ' +
            '/admin/prompts UI before first underwriting-stage risk run.',
        },
      ];

      for (const row of seedRows) {
        const filePath = path.join(promptsDir, row.file);
        let body = null;
        try {
          body = fs.readFileSync(filePath, 'utf8');
        } catch (readErr) {
          console.log(`[migrate] Note: prompts/${row.file} not found on disk, skipping seed for ${row.prompt_key}`);
          continue;
        }

        await pool.query(
          `
          INSERT INTO llm_prompts
            (prompt_key, version, body, is_active, description, parent_version, changelog, edited_by)
          VALUES
            ($1, $2, $3, TRUE, $4, $5, $6, 'system-seed')
          ON CONFLICT (prompt_key, version) DO NOTHING
          `,
          [row.prompt_key, row.version, body, row.description, row.parent_version, row.changelog]
        );
      }

      // Sanity log: which keys are now active
      const activeRes = await pool.query(`
        SELECT prompt_key, version, LENGTH(body) AS body_len
          FROM llm_prompts
         WHERE is_active = TRUE
           AND prompt_key IN ('risk_rubric', 'risk_macro')
         ORDER BY prompt_key
      `);
      const summary = activeRes.rows
        .map((r) => `${r.prompt_key} v${r.version} (${r.body_len} chars)`)
        .join('; ');
      console.log(`[migrate] ✓ llm_prompts seed: ${summary || 'no active risk prompts (files missing?)'}`);
    } catch (err) {
      console.log('[migrate] Note on llm_prompts seed:', err.message.substring(0, 160));
    }

    try {
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS auto_routed BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS auto_route_reason JSONB`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS auto_route_decision_at TIMESTAMPTZ`);
      // M5-2: Tracks whether broker has been notified of the DIP. Idempotency guard
      // — both auto-route path and credit-approve path set it so we don't double-send.
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS dip_broker_notified_at TIMESTAMPTZ`);
      console.log('[migrate] ✓ deal_submissions auto-route columns');
    } catch (err) {
      console.log('[migrate] Note on auto-route columns:', err.message.substring(0, 100));
    }

    // ── M4c Fix (2026-04-20): auto_routed default was FALSE, causing the Credit
    //    Decision UI block to appear on every unissued deal. Semantically
    //    auto_routed should be NULL until Issue DIP fires, then set to TRUE
    //    (auto-issued) or FALSE (held for credit). Fix default + backfill.
    try {
      await pool.query(`ALTER TABLE deal_submissions ALTER COLUMN auto_routed DROP DEFAULT`);
      const bf = await pool.query(`
        UPDATE deal_submissions
        SET auto_routed = NULL
        WHERE dip_issued_at IS NULL
        RETURNING id
      `);
      if (bf.rows.length > 0) {
        console.log(`[migrate] ✓ auto_routed backfilled to NULL on ${bf.rows.length} unissued deal(s)`);
      } else {
        console.log('[migrate] ✓ auto_routed default cleared (no backfill needed)');
      }
    } catch (err) {
      console.log('[migrate] Note on auto_routed default fix:', err.message.substring(0, 120));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DIP v5 — 2026-04-20 (redesign mockup sign-off)
    //  New columns on deal_submissions + admin_config policy rows for the new DIP
    //  rendering. All non-breaking additions; existing renderer ignores them.
    //  Schema changes land here; template switch happens in Commit B.
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS min_value_covenant NUMERIC(15,2)`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS min_loan_term INT DEFAULT 3`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS uses_of_net_loan JSONB DEFAULT '[]'::jsonb`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS day_count_basis VARCHAR(10) DEFAULT '360'`);
      console.log('[migrate] ✓ DIP v5 columns on deal_submissions (min_value_covenant, min_loan_term, uses_of_net_loan, day_count_basis)');
    } catch (err) {
      console.log('[migrate] Note on DIP v5 columns:', err.message.substring(0, 120));
    }

    // ── admin_config: extend with DIP policy clauses (seed defaults if empty) ──
    try {
      await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS cf_treatment_clause_html TEXT`);
      await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS regulatory_disclosure_html TEXT`);
      await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS cf_credit_against_af BOOLEAN DEFAULT TRUE`);

      const CF_DEFAULT = `<ul>
<li><strong>If the deal completes:</strong> the Commitment Fee is credited against the Arrangement Fee payable on completion (Borrower does not pay twice).</li>
<li><strong>If the Borrower withdraws, or if information provided is misrepresented, or if the valuation does not support the proposed lending, or if KYC / AML is not satisfactory:</strong> the Commitment Fee is <strong>forfeited</strong>.</li>
<li><strong>If Daksfirst withdraws for reasons wholly within its own control:</strong> the Commitment Fee <em>may be refunded</em> at Daksfirst's discretion.</li>
</ul>`;

      const REG_DEFAULT = `<p><strong>Regulatory Disclosure &amp; Nature of Facility.</strong> Daksfirst Limited is a private limited company registered in England and Wales under company number <strong>11626401</strong>, with registered office at 8 Hill Street, Mayfair, London W1J 5NG. Daksfirst Limited is authorised and regulated by the Financial Conduct Authority (<strong>FCA No. 937220</strong>).</p>
<p><strong>This facility is an unregulated mortgage contract.</strong> The Borrower is a corporate entity and the secured property is held for investment / commercial purposes, not for occupation by the Borrower or a related individual. Accordingly, the protections afforded to consumers under FCA rules &mdash; including access to the Financial Ombudsman Service and the Financial Services Compensation Scheme (FSCS) &mdash; do not apply to this transaction.</p>
<p>Daksfirst reserves the right to withdraw or amend this DIP at any time prior to the issuance of a binding Facility Letter. The Borrower should not rely on this DIP as a guarantee of funding.</p>`;

      // Seed defaults only if the field is NULL (preserves admin edits)
      await pool.query(
        `UPDATE admin_config SET cf_treatment_clause_html = $1 WHERE id = 1 AND cf_treatment_clause_html IS NULL`,
        [CF_DEFAULT]
      );
      await pool.query(
        `UPDATE admin_config SET regulatory_disclosure_html = $1 WHERE id = 1 AND regulatory_disclosure_html IS NULL`,
        [REG_DEFAULT]
      );
      console.log('[migrate] ✓ admin_config DIP policy clauses (CF treatment + regulatory disclosure)');
    } catch (err) {
      console.log('[migrate] Note on admin_config DIP policy:', err.message.substring(0, 120));
    }

    // ── Stage 4: Candidates payload for broker-assigned parties ──
    try {
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS candidates_payload JSONB`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS candidates_parsed_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS candidates_progress JSONB`);
      console.log('[migrate] ✓ deal_submissions candidates columns (candidates_payload + candidates_parsed_at + candidates_progress)');
    } catch (err) {
      console.log('[migrate] Note on candidates columns:', err.message.substring(0, 120));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  M1 — Credit Analysis Filing Cabinet (2026-04-22)
    //  One append-only row per (deal, stage, engine) analysis ever performed.
    //
    //  Both engines (Anthropic/Claude Opus and in-house Alpha) write into this
    //  table using a shared sanitised feature blob. RM feedback attaches as
    //  richer JSONB (per-finding verdicts + overall 1-5 sliders + free text).
    //
    //  Auth does NOT decide anything here — this is a ledger that captures
    //  engine outputs. The feature blob passed in `features_sent` has PII
    //  stripped upstream (services/deal-feature-packager.js); the allowlist
    //  drives which columns leave auth and which stay behind.
    //
    //  See memory: project_m1_m6_credit_analysis_roadmap.md
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS deal_stage_analyses (
          id                  SERIAL PRIMARY KEY,
          deal_id             INT           NOT NULL REFERENCES deal_submissions(id) ON DELETE CASCADE,
          stage_id            VARCHAR(50)   NOT NULL,
          engine              VARCHAR(20)   NOT NULL CHECK (engine IN ('anthropic','alpha')),
          model_version       VARCHAR(60),
          feature_hash        CHAR(64)      NOT NULL,
          features_sent       JSONB         NOT NULL,
          response            JSONB         NOT NULL DEFAULT '{}'::jsonb,
          cost_gbp            NUMERIC(8,4),
          latency_ms          INTEGER,
          triggered_by        VARCHAR(120),
          triggered_at        TIMESTAMPTZ   DEFAULT NOW(),
          rm_feedback         JSONB,
          error               TEXT
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dsa_deal_stage_engine ON deal_stage_analyses (deal_id, stage_id, engine);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dsa_feature_hash      ON deal_stage_analyses (feature_hash);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dsa_triggered_at      ON deal_stage_analyses (triggered_at DESC);`);
      console.log('[migrate] ✓ deal_stage_analyses table + 3 indexes (M1 credit analysis ledger)');
    } catch (err) {
      console.log('[migrate] Note on deal_stage_analyses:', err.message.substring(0, 120));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Risk MVP v3.1 — Three-axis grading (2026-04-27)
    //  ─────────────────────────────────────────────────────────────────────────
    //  Replaces single HIGH / MED / LOW verdict with PD (1-9) · LGD (A-E) · IA (A-E).
    //  Direction: 1/A = best, 9/E = worst on every axis.
    //
    //  Architecture (signed off in DRAFTS/v3.1-grading-2026-04-27/02_v3_1_grading_spec_v2.md):
    //   - risk_taxonomy_versions: parent table, one row per taxonomy version
    //   - risk_taxonomy:          config rows (determinants, sectors, grade_scale)
    //                             versioned + append-only — adding a determinant
    //                             is a new INSERT under a new version, not a deploy
    //   - risk_view ALTER:        5 new columns surfacing the v3.1 verdict
    //
    //  Layer 2 latent names are NOT pre-defined here — Opus generates them per
    //  deal at run-time and stores them inside grade_matrix.latents[]. The
    //  taxonomy only fixes the 9 Layer 1 determinants + sector list + grade scale.
    //
    //  Append-only: legacy rows (run #9 etc.) leave the new columns NULL and
    //  the frontend renders them under the v3.0 legacy badge.
    //
    //  Read by: services/risk-packager.js (passes active taxonomy into Opus
    //  context), routes/risk.js (returns grade_matrix in run details).
    //  See memory: project_risk_v3_1_design_locked_2026_04_27.md
    // ═══════════════════════════════════════════════════════════════════════════
    try {
      // Parent registry — one row per taxonomy version, supports FK on risk_view
      await pool.query(`
        CREATE TABLE IF NOT EXISTS risk_taxonomy_versions (
          version       TEXT PRIMARY KEY,
          description   TEXT,
          is_active     BOOLEAN NOT NULL DEFAULT FALSE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Partial unique index: at most one active version at a time.
      // Flipping active is a 2-step transaction (UPDATE old → FALSE, UPDATE new → TRUE).
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS risk_taxonomy_versions_one_active
          ON risk_taxonomy_versions (is_active) WHERE is_active = TRUE
      `);

      // Config rows: kind ∈ {determinant, sector, config}. Identified by
      // (version, kind, node_key); ordering drives UI render order.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS risk_taxonomy (
          id            SERIAL PRIMARY KEY,
          version       TEXT NOT NULL REFERENCES risk_taxonomy_versions(version),
          kind          TEXT NOT NULL CHECK (kind IN ('determinant', 'sector', 'config')),
          node_key      TEXT NOT NULL,
          label         TEXT NOT NULL,
          ordering      INTEGER NOT NULL DEFAULT 0,
          metadata      JSONB DEFAULT '{}'::jsonb,
          is_active     BOOLEAN NOT NULL DEFAULT TRUE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (version, kind, node_key)
        )
      `);

      // Hot-path index for the canvas / packager lookup by version + kind.
      await pool.query(`
        CREATE INDEX IF NOT EXISTS risk_taxonomy_version_kind_idx
          ON risk_taxonomy (version, kind, ordering)
      `);

      console.log('[migrate] ✓ risk_taxonomy_versions + risk_taxonomy tables ready');
    } catch (err) {
      console.log('[migrate] Note on risk_taxonomy:', err.message.substring(0, 160));
    }

    // ── risk_view: append-only column additions for v3.1 grading ────────────
    try {
      await pool.query(`
        ALTER TABLE risk_view
          ADD COLUMN IF NOT EXISTS final_pd          INTEGER CHECK (final_pd BETWEEN 1 AND 9)
      `);
      await pool.query(`
        ALTER TABLE risk_view
          ADD COLUMN IF NOT EXISTS final_lgd         CHAR(1) CHECK (final_lgd IN ('A','B','C','D','E'))
      `);
      await pool.query(`
        ALTER TABLE risk_view
          ADD COLUMN IF NOT EXISTS final_ia          CHAR(1) CHECK (final_ia IN ('A','B','C','D','E'))
      `);
      await pool.query(`
        ALTER TABLE risk_view
          ADD COLUMN IF NOT EXISTS grade_matrix      JSONB
      `);
      await pool.query(`
        ALTER TABLE risk_view
          ADD COLUMN IF NOT EXISTS taxonomy_version  TEXT REFERENCES risk_taxonomy_versions(version)
      `);

      // Filtering / pipeline ranking indexes on the top-level grade columns.
      await pool.query(`CREATE INDEX IF NOT EXISTS risk_view_final_pd_idx       ON risk_view (final_pd)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS risk_view_final_lgd_idx      ON risk_view (final_lgd)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS risk_view_taxonomy_ver_idx   ON risk_view (taxonomy_version)`);

      console.log('[migrate] ✓ risk_view v3.1 columns: final_pd, final_lgd, final_ia, grade_matrix, taxonomy_version');
    } catch (err) {
      console.log('[migrate] Note on risk_view v3.1 columns:', err.message.substring(0, 160));
    }

    // ── Seed tax_v1: 9 determinants + 6 sectors + 1 grade_scale config ──────
    //   Adding/removing/renaming a determinant later = INSERT under a new
    //   version (e.g. tax_v2), flip is_active. NEVER mutate existing rows.
    try {
      // 1. Register the version
      await pool.query(`
        INSERT INTO risk_taxonomy_versions (version, description, is_active)
        VALUES ('tax_v1', 'Risk taxonomy v1 — 9 determinants + 6 sectors + grade_scale config (2026-04-27)', TRUE)
        ON CONFLICT (version) DO NOTHING
      `);

      // 2. Seed determinants (9 — Layer 1 dimensions, fixed across deals)
      const determinants = [
        ['borrower_profile',  'Borrower profile',         1, { description: 'Identity, track record, experience, adverse credit' }],
        ['borrower_alm',      'Borrower ALM',             2, { description: 'Assets, liabilities, liquidity, ICR/DSCR coverage' }],
        ['guarantors',        'Guarantors',               3, { description: 'Personal/corporate guarantors, net worth, recourse strength' }],
        ['property_physical', 'Property (physical)',      4, { description: 'Condition, EPC, PTAL, location quality, rentability' }],
        ['valuation',         'Valuation',                5, { description: 'AVM band, surveyor view, comparables, marketing buffer' }],
        ['use_of_funds',      'Use of funds',             6, { description: 'Purpose clarity, alignment with exit, business logic' }],
        ['exit_pathway',      'Exit pathway',             7, { description: 'Refinance/sale credibility, timing, marketability' }],
        ['legal_insurance',   'Legal & insurance',        8, { description: 'Title quality, charges, leases, insurance adequacy' }],
        ['compliance_kyc',    'Compliance / KYC',         9, { description: 'KYC/AML completeness, sanctions, source of funds, PEP' }],
      ];
      for (const [key, label, order, meta] of determinants) {
        await pool.query(
          `INSERT INTO risk_taxonomy (version, kind, node_key, label, ordering, metadata, is_active)
           VALUES ('tax_v1', 'determinant', $1, $2, $3, $4::jsonb, TRUE)
           ON CONFLICT (version, kind, node_key) DO NOTHING`,
          [key, label, order, JSON.stringify(meta)]
        );
      }

      // 3. Seed sectors (6 — broad-brush; refine via tax_v2 once we have data)
      const sectors = [
        ['resi_bridging',  'Residential bridging', 1, { description: 'Short-term resi loans, owner-occupier or investment' }],
        ['commercial',     'Commercial',           2, { description: 'Office, retail, industrial — single or mixed tenant' }],
        ['resi_btl',       'Residential BTL',      3, { description: 'Buy-to-let portfolios, single or HMO' }],
        ['land_planning',  'Land with planning',   4, { description: 'Sites with planning consent (no ground-up build)' }],
        ['mixed_use',      'Mixed-use',            5, { description: 'Combined resi + commercial in single asset' }],
        ['hospitality',    'Hospitality',          6, { description: 'Hotels, serviced apartments, F&B operating assets' }],
      ];
      for (const [key, label, order, meta] of sectors) {
        await pool.query(
          `INSERT INTO risk_taxonomy (version, kind, node_key, label, ordering, metadata, is_active)
           VALUES ('tax_v1', 'sector', $1, $2, $3, $4::jsonb, TRUE)
           ON CONFLICT (version, kind, node_key) DO NOTHING`,
          [key, label, order, JSON.stringify(meta)]
        );
      }

      // 4. Grade scale config — the [1-9]:[A-E]:[A-E] axes definition + colour ramp
      const gradeScaleMeta = {
        pd_scale:  { min: 1, max: 9, direction: 'low_is_best', percentile_rule: 'PD 1 = top decile, PD 5 = median, PD 9 = bottom decile (per sector)' },
        lgd_scale: { values: ['A','B','C','D','E'], direction: 'A_is_best' },
        ia_scale:  { values: ['A','B','C','D','E'], direction: 'A_is_best', name: 'Information Availability', notes: 'Pure LLM judgement weighting public-verified vs borrower-volunteered evidence' },
        colour_ramp: {
          '1A': '#1f7a3a', '5C': '#c79b3e', '9E': '#a8332b',
          stops: [
            { coord: '1A', hex: '#1f7a3a', label: 'best' },
            { coord: '3B', hex: '#5fa84a' },
            { coord: '5C', hex: '#c79b3e', label: 'median' },
            { coord: '7D', hex: '#d97933' },
            { coord: '9E', hex: '#a8332b', label: 'worst' },
          ],
        },
        layers: {
          layer_1_count: 9,
          layer_2_emergent: true,
          layer_2_target_count: 3,
          layer_3_count: 1,
        },
      };
      await pool.query(
        `INSERT INTO risk_taxonomy (version, kind, node_key, label, ordering, metadata, is_active)
         VALUES ('tax_v1', 'config', 'grade_scale', 'Grade scale (PD · LGD · IA)', 0, $1::jsonb, TRUE)
         ON CONFLICT (version, kind, node_key) DO NOTHING`,
        [JSON.stringify(gradeScaleMeta)]
      );

      // Sanity log
      const summary = await pool.query(`
        SELECT kind, COUNT(*)::int AS n
          FROM risk_taxonomy
         WHERE version = 'tax_v1' AND is_active = TRUE
         GROUP BY kind
         ORDER BY kind
      `);
      const summaryStr = summary.rows.map((r) => `${r.kind}=${r.n}`).join(', ');
      console.log(`[migrate] ✓ risk_taxonomy tax_v1 seeded: ${summaryStr || 'no rows (already seeded?)'}`);
    } catch (err) {
      console.log('[migrate] Note on risk_taxonomy seed:', err.message.substring(0, 160));
    }

    // ============================================================
    // HMLR (HM Land Registry) Business Gateway integration columns
    //   Pattern: latest pull only, attached to deal_properties (mirrors Chimnie).
    //   All cols nullable — mock mode is the default until live creds arrive,
    //   so production rows can sit at NULL indefinitely with no harm.
    //   Sumit signed off architecture 2026-04-27: cols on deal_properties only,
    //   admin-only button + admin-only display, mock|test|live mode flag.
    // ============================================================
    try {
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_title_number       VARCHAR(20)`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_register_pdf_url   TEXT`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_register_raw_jsonb JSONB`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_proprietors_jsonb  JSONB`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_charges_jsonb      JSONB`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_restrictions_jsonb JSONB`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_tenure             VARCHAR(20)`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_class_of_title     VARCHAR(40)`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_pulled_at          TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_pulled_cost_pence  INT`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_pull_mode          VARCHAR(10)`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_pull_error         TEXT`);
      await pool.query(`ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS hmlr_pulled_by          INT`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_props_hmlr_title ON deal_properties(hmlr_title_number)`);
      console.log('[migrate] ✓ HMLR integration columns ready on deal_properties');
    } catch (err) {
      console.log('[migrate] Note on HMLR columns:', err.message.substring(0, 160));
    }

    // ============================================================
    // SmartSearch (KYC/AML) — kyc_checks table (append-only history)
    //   Sumit signed off architecture 2026-04-27:
    //     - SEPARATE history table (NOT latest-only on borrowers/companies)
    //     - All four products: individual KYC, business KYB,
    //       sanctions/PEP, ongoing monitoring
    //     - Admin-only manual trigger (Q1) — no auto-fire on borrower create
    //     - Q2: per-subject endpoints + a batch sweep endpoint for directors
    //     - Q3: monitoring is admin-pick (NOT auto-enrol on every passed check)
    //   Pattern mirrors risk_view: append-only run-log, FKs nullable to allow
    //   webhook-driven monitoring updates with no logged-in user.
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kyc_checks (
          id                       SERIAL PRIMARY KEY,
          deal_id                  INT,
          borrower_id              INT,
          director_id              INT,
          individual_id            INT,
          company_id               INT,
          check_type               VARCHAR(40)  NOT NULL,
          provider                 VARCHAR(40)  NOT NULL DEFAULT 'smartsearch',
          subject_first_name       VARCHAR(120),
          subject_last_name        VARCHAR(120),
          subject_dob              DATE,
          subject_address_jsonb    JSONB,
          subject_company_number   VARCHAR(20),
          subject_company_name     VARCHAR(255),
          result_status            VARCHAR(20),
          result_score             INT,
          result_summary_jsonb     JSONB,
          result_raw_jsonb         JSONB,
          sanctions_hits_jsonb     JSONB,
          pep_hits_jsonb           JSONB,
          rca_hits_jsonb           JSONB,
          sip_hits_jsonb           JSONB,
          adverse_media_jsonb      JSONB,
          mode                     VARCHAR(10)  NOT NULL DEFAULT 'mock',
          cost_pence               INT          NOT NULL DEFAULT 0,
          requested_by             INT,
          requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          parent_check_id          INT,
          is_monitoring_update     BOOLEAN      NOT NULL DEFAULT FALSE,
          pull_error               TEXT
        )
      `);
      // Indexes: deal lookup, subject lookup, type filter, "latest per type per
      // deal" composite, monitoring chain walks.
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_deal_id          ON kyc_checks(deal_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_borrower_id      ON kyc_checks(borrower_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_company_id       ON kyc_checks(company_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_director_id      ON kyc_checks(director_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_check_type       ON kyc_checks(check_type)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_parent           ON kyc_checks(parent_check_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_kyc_checks_deal_type_at     ON kyc_checks(deal_id, check_type, requested_at DESC)`);
      console.log('[migrate] ✓ kyc_checks table + indexes ready (SmartSearch append-only)');
    } catch (err) {
      console.log('[migrate] Note on kyc_checks:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-27: credit_checks — append-only Experian (and future
    // Equifax) credit bureau lookup history.
    //   - Sumit's call: Experian first, Equifax later as Phase C
    //     ⇒ vendor column NOT NULL DEFAULT 'experian' so adding a
    //     second bureau later is a one-line code change
    //   - Three products at launch:
    //       commercial_delphi  — SPV/Ltd commercial credit score (0-100)
    //                            + recommended limit + payment behaviour
    //       personal_credit    — Guarantor credit file (0-999 score)
    //                            + CCJ + bankruptcy + IVA + electoral roll
    //       hunter_fraud       — CIFAS fraud markers (bundled with Experian)
    //   - Mirrors kyc_checks shape: per-subject FKs, append-only, mode flag,
    //     cost_pence, parent_check_id for sweep aggregation
    //   - Architecture: auth = data collector (Experian results flow into
    //     risk packager <credit_data> block, NOT into local decisions)
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS credit_checks (
          id                       SERIAL PRIMARY KEY,
          deal_id                  INT,
          borrower_id              INT,
          director_id              INT,
          individual_id            INT,
          company_id               INT,
          product                  VARCHAR(40)  NOT NULL,
          vendor                   VARCHAR(40)  NOT NULL DEFAULT 'experian',
          subject_first_name       VARCHAR(120),
          subject_last_name        VARCHAR(120),
          subject_dob              DATE,
          subject_address_jsonb    JSONB,
          subject_company_number   VARCHAR(20),
          subject_company_name     VARCHAR(255),
          result_status            VARCHAR(20),
          result_grade             VARCHAR(20),
          credit_score             INT,
          recommended_limit_pence  BIGINT,
          result_summary_jsonb     JSONB,
          result_raw_jsonb         JSONB,
          ccj_count                INT,
          ccj_value_pence          BIGINT,
          ccj_jsonb                JSONB,
          bankruptcy_flag          BOOLEAN,
          iva_flag                 BOOLEAN,
          default_count            INT,
          default_value_pence      BIGINT,
          electoral_roll_jsonb     JSONB,
          gone_away_flag           BOOLEAN,
          payment_behaviour_jsonb  JSONB,
          gazette_jsonb            JSONB,
          fraud_markers_jsonb      JSONB,
          hunter_match_count       INT,
          adverse_jsonb            JSONB,
          mode                     VARCHAR(10)  NOT NULL DEFAULT 'mock',
          cost_pence               INT          NOT NULL DEFAULT 0,
          requested_by             INT,
          requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          parent_check_id          INT,
          pull_error               TEXT
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_deal_id        ON credit_checks(deal_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_borrower_id    ON credit_checks(borrower_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_company_id     ON credit_checks(company_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_director_id    ON credit_checks(director_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_product        ON credit_checks(product)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_vendor         ON credit_checks(vendor)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_parent         ON credit_checks(parent_check_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_checks_deal_prod_at   ON credit_checks(deal_id, product, requested_at DESC)`);
      console.log('[migrate] ✓ credit_checks table + indexes ready (Experian append-only)');
    } catch (err) {
      console.log('[migrate] Note on credit_checks:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28: approved_valuers — admin-managed panel of RICS valuation firms
    //   - Soft policy (Sumit's call 2026-04-28): off-panel valuer allowed but
    //     flagged in IA grade. RM picks from approved list OR types "Other" via
    //     deal_valuations.valuer_off_panel_name.
    //   - approved_by_funder TEXT[] tracks which funders (daksfirst, gb_bank,
    //     starling_warehouse) have approved each firm — different funders have
    //     different panels (GB Bank's panel may be subset/superset of ours).
    //   - PI insurance fields for compliance audit (provider, amount, expiry).
    //   - Soft-delete via status ('active'|'suspended'|'removed') + audit
    //     (added_by/at, removed_by/at/reason). Never hard-delete — historic
    //     deals must keep their valuer attribution intact.
    //   - GIN index on approved_by_funder for "show me firms approved by
    //     daksfirst" filter in admin/panels.html.
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS approved_valuers (
          id                          SERIAL PRIMARY KEY,
          firm_name                   VARCHAR(255) NOT NULL,
          firm_address                TEXT,
          firm_postcode               VARCHAR(10),
          firm_phone                  VARCHAR(50),
          firm_email                  VARCHAR(255),
          firm_website                VARCHAR(255),
          rics_regulated              BOOLEAN      NOT NULL DEFAULT TRUE,
          rics_firm_number            VARCHAR(50),
          companies_house_number      VARCHAR(20),
          specialisms                 TEXT[],
          geographic_coverage         TEXT[],
          approved_by_funder          TEXT[]       NOT NULL DEFAULT ARRAY['daksfirst']::TEXT[],
          pi_insurance_provider       VARCHAR(255),
          pi_insurance_amount_pence   BIGINT,
          pi_insurance_expiry         DATE,
          status                      VARCHAR(20)  NOT NULL DEFAULT 'active',
          notes                       TEXT,
          added_by_user_id            INT,
          added_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          removed_by_user_id          INT,
          removed_at                  TIMESTAMPTZ,
          removed_reason              TEXT
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_approved_valuers_status     ON approved_valuers(status)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_approved_valuers_firm_name  ON approved_valuers(firm_name)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_approved_valuers_funders    ON approved_valuers USING GIN(approved_by_funder)`);
      console.log('[migrate] ✓ approved_valuers table + indexes ready (panel of RICS firms)');
    } catch (err) {
      console.log('[migrate] Note on approved_valuers:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28: approved_lawyers — admin-managed panel of conveyancing firms
    //   Same pattern as approved_valuers; SRA-regulated; cdd_undertaking_signed
    //   flag tracks whether they've signed Daksfirst's CDD undertaking template
    //   (a prereq for instructing them on completion). Used by future
    //   deal_legal_status table (Sprint 1a item #8 — solicitor data).
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS approved_lawyers (
          id                          SERIAL PRIMARY KEY,
          firm_name                   VARCHAR(255) NOT NULL,
          firm_address                TEXT,
          firm_postcode               VARCHAR(10),
          firm_phone                  VARCHAR(50),
          firm_email                  VARCHAR(255),
          firm_website                VARCHAR(255),
          sra_regulated               BOOLEAN      NOT NULL DEFAULT TRUE,
          sra_number                  VARCHAR(20),
          companies_house_number      VARCHAR(20),
          specialisms                 TEXT[],
          geographic_coverage         TEXT[],
          approved_by_funder          TEXT[]       NOT NULL DEFAULT ARRAY['daksfirst']::TEXT[],
          pi_insurance_provider       VARCHAR(255),
          pi_insurance_amount_pence   BIGINT,
          pi_insurance_expiry         DATE,
          cdd_undertaking_signed      BOOLEAN      NOT NULL DEFAULT FALSE,
          cdd_undertaking_date        DATE,
          status                      VARCHAR(20)  NOT NULL DEFAULT 'active',
          notes                       TEXT,
          added_by_user_id            INT,
          added_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          removed_by_user_id          INT,
          removed_at                  TIMESTAMPTZ,
          removed_reason              TEXT
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_approved_lawyers_status    ON approved_lawyers(status)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_approved_lawyers_firm_name ON approved_lawyers(firm_name)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_approved_lawyers_funders   ON approved_lawyers USING GIN(approved_by_funder)`);
      console.log('[migrate] ✓ approved_lawyers table + indexes ready (panel of conveyancing firms)');
    } catch (err) {
      console.log('[migrate] Note on approved_lawyers:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28: deal_valuations — Pattern B evidence table for RICS valuation reports.
    //   - Append-only with revision chain (superseded_by_id + status enum).
    //     Status: draft | finalised | superseded.
    //   - lending_value_pence is THE LTV anchor (replaces broker-stated value
    //     in rubric/pricing layers, per Sumit's lock 2026-04-28).
    //   - 6-month drawdown gate enforced at SELECT-time, NOT via generated col
    //     (CURRENT_DATE is not immutable so generated cols can't reference it):
    //       SELECT * FROM deal_valuations
    //       WHERE deal_id=$1 AND status='finalised' AND superseded_by_id IS NULL
    //         AND valuation_date >= CURRENT_DATE - INTERVAL '6 months'
    //   - valuer_id FK to approved_valuers (nullable for soft policy).
    //     When NULL, valuer_off_panel_name carries free-text firm name and the
    //     rubric flags this as off-panel risk in the IA grade.
    //   - document_id FK to deal_documents — RICS PDF stored once via existing
    //     deal_documents BYTEA layer; valuation references it.
    //   - property_id FK to deal_properties — multi-property deals get N
    //     valuations, one per property.
    //   - All money fields stored as BIGINT pence (existing convention,
    //     mirrors fee_*_pence and recommended_limit_pence).
    //   - Pattern B scaffolding (Sumit's design 2026-04-28) — same shape will
    //     be reused by deal_environmental and borrower_tax_returns later.
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS deal_valuations (
          id                            SERIAL PRIMARY KEY,
          deal_id                       INT          NOT NULL,
          property_id                   INT,
          status                        VARCHAR(20)  NOT NULL DEFAULT 'draft',
          document_id                   INT,
          valuer_id                     INT,
          valuer_off_panel_name         VARCHAR(255),
          valuation_method              VARCHAR(30),
          rics_member_name              VARCHAR(255),
          rics_member_number            VARCHAR(50),
          valuation_date                DATE,
          inspection_date               DATE,
          market_value_pence            BIGINT,
          vp_value_pence                BIGINT,
          lending_value_pence           BIGINT,
          mortgage_lending_value_pence  BIGINT,
          comparable_count              INT,
          condition_grade               VARCHAR(20),
          marketability_grade           VARCHAR(20),
          key_risks                     TEXT[],
          assumptions                   TEXT,
          recommendations               TEXT,
          underwriter_commentary        TEXT,
          submitted_by_user_id          INT,
          submitted_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          finalised_by_user_id          INT,
          finalised_at                  TIMESTAMPTZ,
          superseded_by_id              INT,
          superseded_at                 TIMESTAMPTZ
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_deal        ON deal_valuations(deal_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_property    ON deal_valuations(property_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_valuer      ON deal_valuations(valuer_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_status      ON deal_valuations(status)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_superseded  ON deal_valuations(superseded_by_id)`);
      // Composite for the 6-month drawdown gate query (active rows only)
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_deal_active ON deal_valuations(deal_id, valuation_date DESC) WHERE status = 'finalised' AND superseded_by_id IS NULL`);
      console.log('[migrate] ✓ deal_valuations table + indexes ready (Pattern B evidence — RICS val)');
    } catch (err) {
      console.log('[migrate] Note on deal_valuations:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 2): deal_valuations expansion
    //   Refurb cols (6) — for refurb deals where bridging lender lends against
    //     as-is, 180-day MV, or GDV depending on structure. lending_value_basis
    //     records which of as_is | 180_day_mv | gdv | mv | mv_subject_to_works
    //     was used to anchor lending_value_pence.
    //   Sale-side demand cols (5) — RICS valuer's view of sale exit viability.
    //     valuer_* prefix to distinguish from chimnie's area-level baseline
    //     already on deal_properties (chimnie_area_days_to_sell).
    //   Letting-side demand cols (7) — RICS valuer's view of refi-to-BTL exit
    //     viability. achievable_rent_pcm_pence + estimated_gross_yield_pct
    //     feed DSCR calc against target refi rate.
    //   Comparables (2 JSONB) — structured arrays of comp sales/lettings
    //     captured from the RICS report.
    //
    //   All ADD IF NOT EXISTS for idempotent re-runs.
    //
    //   LOS scope only — no versioning chain. See feedback_los_vs_lms_scope_discipline.md
    //   The existing superseded_by_id chain stays for now but new UI doesn't
    //   expose it; updates in place during origination.
    // ============================================================
    try {
      const valColumns = [
        // Refurb (6)
        'ADD COLUMN IF NOT EXISTS as_is_value_pence              BIGINT',
        'ADD COLUMN IF NOT EXISTS market_value_180day_pence      BIGINT',
        'ADD COLUMN IF NOT EXISTS gdv_pence                      BIGINT',
        'ADD COLUMN IF NOT EXISTS works_cost_estimate_pence      BIGINT',
        'ADD COLUMN IF NOT EXISTS is_refurb_deal                 BOOLEAN DEFAULT FALSE',
        'ADD COLUMN IF NOT EXISTS lending_value_basis            VARCHAR(30)',
        // Sale-side demand (5)
        'ADD COLUMN IF NOT EXISTS valuer_days_to_sell_estimate   INT',
        'ADD COLUMN IF NOT EXISTS sale_demand_grade              VARCHAR(20)',
        'ADD COLUMN IF NOT EXISTS recent_local_sales_count       INT',
        'ADD COLUMN IF NOT EXISTS local_price_trend_12m_pct      NUMERIC(6,2)',
        'ADD COLUMN IF NOT EXISTS sale_marketability_commentary  TEXT',
        // Letting-side demand (7)
        'ADD COLUMN IF NOT EXISTS valuer_days_to_let_estimate      INT',
        'ADD COLUMN IF NOT EXISTS letting_demand_grade             VARCHAR(20)',
        'ADD COLUMN IF NOT EXISTS achievable_rent_pcm_pence        BIGINT',
        'ADD COLUMN IF NOT EXISTS estimated_gross_yield_pct        NUMERIC(6,3)',
        'ADD COLUMN IF NOT EXISTS recent_local_lettings_count      INT',
        'ADD COLUMN IF NOT EXISTS local_rent_trend_12m_pct         NUMERIC(6,2)',
        'ADD COLUMN IF NOT EXISTS letting_marketability_commentary TEXT',
        // Comparables (2 JSONB)
        'ADD COLUMN IF NOT EXISTS comparable_sales_jsonb     JSONB',
        'ADD COLUMN IF NOT EXISTS comparable_lettings_jsonb  JSONB'
      ];
      for (const colSql of valColumns) {
        try {
          await pool.query('ALTER TABLE deal_valuations ' + colSql);
        } catch (err) {
          // ADD COLUMN IF NOT EXISTS is idempotent on PG 9.6+; this catch is
          // defensive against rare race / ordering issues.
          console.log('[migrate] Note on deal_valuations col:', err.message.substring(0, 160));
        }
      }
      // Optional helper indexes — refurb filter + lending_value_basis filter
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_is_refurb ON deal_valuations(is_refurb_deal) WHERE is_refurb_deal = TRUE`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_valuations_basis    ON deal_valuations(lending_value_basis)`);
      console.log('[migrate] ✓ deal_valuations refurb + sale/letting cols ready (Sprint 2)');
    } catch (err) {
      console.log('[migrate] Note on deal_valuations Sprint 2 expansion:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 2): deal_submissions — exit strategy structured cols
    //   Existing exit_strategy / exit_strategy_requested / exit_strategy_approved
    //   text fields stay as the approval-flow audit (set at DIP).
    //   New structured cols (12) are the analytical view that the rubric reads
    //   to grade exit viability against valuer's marketability indicators.
    //
    //   primary route enum:
    //     refinance_btl | refinance_owner_occ | refinance_commercial | sale | combination
    //   confidence enums: high | medium | low (both borrower-stated and UW-assessed)
    //
    //   No new table — single snapshot per deal. Plan evolution = LMS scope.
    // ============================================================
    try {
      const exitColumns = [
        'ADD COLUMN IF NOT EXISTS exit_route_primary                    VARCHAR(30)',
        'ADD COLUMN IF NOT EXISTS exit_route_secondary                  VARCHAR(30)',
        'ADD COLUMN IF NOT EXISTS exit_target_date                      DATE',
        'ADD COLUMN IF NOT EXISTS exit_target_disposal_window_days      INT',
        'ADD COLUMN IF NOT EXISTS exit_target_refi_lender               VARCHAR(255)',
        'ADD COLUMN IF NOT EXISTS exit_target_refi_loan_pence           BIGINT',
        'ADD COLUMN IF NOT EXISTS exit_target_refi_ltv_pct              NUMERIC(6,2)',
        'ADD COLUMN IF NOT EXISTS exit_target_refi_rate_pct_pa          NUMERIC(6,3)',
        'ADD COLUMN IF NOT EXISTS exit_expected_disposal_proceeds_pence BIGINT',
        'ADD COLUMN IF NOT EXISTS exit_borrower_stated_confidence       VARCHAR(20)',
        'ADD COLUMN IF NOT EXISTS exit_underwriter_assessed_confidence  VARCHAR(20)',
        'ADD COLUMN IF NOT EXISTS exit_underwriter_commentary           TEXT'
      ];
      for (const colSql of exitColumns) {
        try {
          await pool.query('ALTER TABLE deal_submissions ' + colSql);
        } catch (err) {
          console.log('[migrate] Note on deal_submissions exit col:', err.message.substring(0, 160));
        }
      }
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_exit_route_primary ON deal_submissions(exit_route_primary)`);
      console.log('[migrate] ✓ deal_submissions exit strategy structured cols ready (Sprint 2 — 12 cols)');
    } catch (err) {
      console.log('[migrate] Note on deal_submissions exit cols:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 3 #16): Sources & Uses balanced funding stack
    //   Existing cols already cover: purchase_price (uses), refurb_cost (uses),
    //   loan_amount_approved (sources_senior_loan derived), arrangement_fee_pct
    //   + broker_fee_pct + commitment_fee + dip_fee (uses, derived).
    //
    //   Adding 8 new cols for the gaps:
    //     Uses:    SDLT, legal fees, other (amount + description)
    //     Sources: second_charge, equity, other (amount + description)
    //
    //   Sources MUST equal Uses (soft balance check in UI). Stored as NUMERIC
    //   in £ (matching existing matrix money convention — purchase_price,
    //   current_value etc. are all £-direct, not pence).
    // ============================================================
    try {
      const susColumns = [
        // Uses gaps
        'ADD COLUMN IF NOT EXISTS uses_sdlt              NUMERIC',
        'ADD COLUMN IF NOT EXISTS uses_legal_fees        NUMERIC',
        'ADD COLUMN IF NOT EXISTS uses_other_amount      NUMERIC',
        'ADD COLUMN IF NOT EXISTS uses_other_description VARCHAR(255)',
        // Sources gaps
        'ADD COLUMN IF NOT EXISTS sources_second_charge  NUMERIC',
        'ADD COLUMN IF NOT EXISTS sources_equity         NUMERIC',
        'ADD COLUMN IF NOT EXISTS sources_other_amount   NUMERIC',
        'ADD COLUMN IF NOT EXISTS sources_other_description VARCHAR(255)'
      ];
      for (const colSql of susColumns) {
        try {
          await pool.query('ALTER TABLE deal_submissions ' + colSql);
        } catch (err) {
          console.log('[migrate] Note on S&U col:', err.message.substring(0, 160));
        }
      }
      console.log('[migrate] ✓ deal_submissions Sources & Uses cols ready (Sprint 3 #16 — 8 cols)');
    } catch (err) {
      console.log('[migrate] Note on Sources & Uses:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 3 #17): Per-UBO assets, liabilities, and
    // property portfolio with ownership %.
    //   borrower_id FK → deal_borrowers(id) so this works for ANY
    //   individual party on a deal: primary, joint, guarantor, director,
    //   PSC, UBO. UBOs get their own balance sheet alongside other roles.
    //
    //   ownership_pct (0-100) records the share they BENEFICIALLY own —
    //   they may own a property 50/50 with spouse, or hold an asset
    //   indirectly via an SPV. Effective net worth = Σ(asset × pct/100)
    //   − Σ(liability × pct/100).
    //
    //   Two tables:
    //     borrower_portfolio_properties — properties only, with rental
    //       income + interest charges so net rental is computable.
    //     borrower_other_assets_liabilities — everything else (cash,
    //       investments, director loans, personal loans, credit cards,
    //       etc.) split by `kind` (asset|liability).
    //
    //   Both append-style — no soft-delete, but a deleted_at column
    //   for retention + audit.
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS borrower_portfolio_properties (
          id                       SERIAL PRIMARY KEY,
          borrower_id              INT NOT NULL,
          address                  TEXT,
          postcode                 VARCHAR(20),
          property_type            VARCHAR(50),
          tenure                   VARCHAR(20),
          occupancy                VARCHAR(20),
          market_value             NUMERIC,
          mortgage_outstanding     NUMERIC,
          mortgage_lender          VARCHAR(255),
          mortgage_rate_pct_pa     NUMERIC(6,3),
          monthly_rent             NUMERIC,
          monthly_interest         NUMERIC,
          ownership_pct            NUMERIC(5,2),
          ownership_via            TEXT,
          notes                    TEXT,
          added_by_user_id         INT,
          added_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at               TIMESTAMPTZ
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bpp_borrower    ON borrower_portfolio_properties(borrower_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bpp_active      ON borrower_portfolio_properties(borrower_id) WHERE deleted_at IS NULL`);
      console.log('[migrate] ✓ borrower_portfolio_properties table + indexes ready (Sprint 3 #17)');
    } catch (err) {
      console.log('[migrate] Note on borrower_portfolio_properties:', err.message.substring(0, 160));
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS borrower_other_assets_liabilities (
          id                       SERIAL PRIMARY KEY,
          borrower_id              INT NOT NULL,
          kind                     VARCHAR(20) NOT NULL,
          category                 VARCHAR(50),
          description              TEXT,
          amount                   NUMERIC,
          ownership_pct            NUMERIC(5,2),
          ownership_via            TEXT,
          notes                    TEXT,
          added_by_user_id         INT,
          added_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at               TIMESTAMPTZ
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_boal_borrower   ON borrower_other_assets_liabilities(borrower_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_boal_kind       ON borrower_other_assets_liabilities(kind)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_boal_active     ON borrower_other_assets_liabilities(borrower_id, kind) WHERE deleted_at IS NULL`);
      console.log('[migrate] ✓ borrower_other_assets_liabilities table + indexes ready (Sprint 3 #17)');
    } catch (err) {
      console.log('[migrate] Note on borrower_other_assets_liabilities:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 3 #18): CH directorships discovery for KYC.
    //
    // Pulled automatically when an individual borrower's CH appointment
    // is recorded (i.e. as part of corporate-borrower CH verify, for
    // each director/PSC found). Uses GET /officers/{officer_id}/appointments
    // from Companies House API.
    //
    // troublesome_reasons[] populated by service rules when storing each
    // row. Reasons: 'dissolved' | 'liquidation' | 'in_administration' |
    // 'receivership' | 'voluntary_arrangement' | 'strike_off_pending' |
    // 'phoenix_pattern' (resigned within 6 months of dissolution) |
    // 'competitor_lender' (against a maintained list).
    //
    // is_troublesome generated col flips true when reasons array non-empty.
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS borrower_other_directorships (
          id                     SERIAL PRIMARY KEY,
          borrower_id            INT NOT NULL,
          ch_officer_id          VARCHAR(100),
          company_number         VARCHAR(20),
          company_name           VARCHAR(255),
          company_status         VARCHAR(50),
          officer_role           VARCHAR(50),
          appointment_date       DATE,
          resignation_date       DATE,
          is_active              BOOLEAN GENERATED ALWAYS AS (resignation_date IS NULL) STORED,
          troublesome_reasons    TEXT[],
          is_troublesome         BOOLEAN GENERATED ALWAYS AS (
            troublesome_reasons IS NOT NULL AND array_length(troublesome_reasons, 1) > 0
          ) STORED,
          pulled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bod_borrower         ON borrower_other_directorships(borrower_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bod_company_number   ON borrower_other_directorships(company_number)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bod_troublesome      ON borrower_other_directorships(borrower_id) WHERE is_troublesome = TRUE`);
      console.log('[migrate] ✓ borrower_other_directorships table + indexes ready (Sprint 3 #18)');
    } catch (err) {
      console.log('[migrate] Note on borrower_other_directorships:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 4 #19): refinance-aware Sources & Uses.
    //   Acquisition deals use purchase_price (existing). Refinance /
    //   cash-out / chain-break / bridge-to-* deals use loan_redemption
    //   (the existing lender's payoff figure). Conditional rendering
    //   in the matrix UI driven by loan_purpose.
    // ============================================================
    try {
      await pool.query(`ALTER TABLE deal_submissions ADD COLUMN IF NOT EXISTS uses_loan_redemption NUMERIC`);
      console.log('[migrate] ✓ deal_submissions.uses_loan_redemption ready (Sprint 4 #19)');
    } catch (err) {
      console.log('[migrate] Note on uses_loan_redemption:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 4 #20): Per-UBO income & expenses.
    //   Mirrors borrower_other_assets_liabilities pattern but for
    //   income/expense flows. frequency normalises monthly vs annual
    //   capture. ownership_pct + ownership_via for partial economic
    //   interest (e.g. joint income with spouse).
    //
    //   Used for net-monthly-income roll-up + DSCR-style affordability
    //   the rubric reads alongside the balance sheet.
    // ============================================================
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS borrower_income_expenses (
          id                       SERIAL PRIMARY KEY,
          borrower_id              INT NOT NULL,
          kind                     VARCHAR(20) NOT NULL,
          category                 VARCHAR(50),
          description              TEXT,
          amount                   NUMERIC,
          frequency                VARCHAR(20) DEFAULT 'monthly',
          ownership_pct            NUMERIC(5,2),
          ownership_via            TEXT,
          notes                    TEXT,
          added_by_user_id         INT,
          added_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at               TIMESTAMPTZ
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bie_borrower  ON borrower_income_expenses(borrower_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bie_kind      ON borrower_income_expenses(kind)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_bie_active    ON borrower_income_expenses(borrower_id, kind) WHERE deleted_at IS NULL`);
      console.log('[migrate] ✓ borrower_income_expenses table + indexes ready (Sprint 4 #20)');
    } catch (err) {
      console.log('[migrate] Note on borrower_income_expenses:', err.message.substring(0, 160));
    }

    // ============================================================
    // 2026-04-28 (Sprint 2 fix): rename two exit money cols to drop the
    // _pence suffix. Matrix convention on deal_submissions stores £ values
    // directly in BIGINT/NUMERIC cols (current_value, purchase_price, etc.),
    // not pence. The earlier migration mistakenly used _pence suffix; this
    // aligns the naming. Idempotent — only renames if old name still exists.
    // ============================================================
    try {
      const renamePairs = [
        ['exit_target_refi_loan_pence',           'exit_target_refi_loan'],
        ['exit_expected_disposal_proceeds_pence', 'exit_expected_disposal_proceeds']
      ];
      for (const [oldName, newName] of renamePairs) {
        const exists = await pool.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_name = 'deal_submissions' AND column_name = $1`,
          [oldName]
        );
        if (exists.rows.length > 0) {
          await pool.query(`ALTER TABLE deal_submissions RENAME COLUMN ${oldName} TO ${newName}`);
          console.log('[migrate] ✓ renamed deal_submissions.' + oldName + ' → ' + newName);
        }
      }
    } catch (err) {
      console.log('[migrate] Note on exit cols rename:', err.message.substring(0, 160));
    }

    console.log('[migrate] All tables and indexes created/updated successfully');
  } catch (err) {
    console.error('[migrate] Migration failed:', err.message);
    throw err;
  }
}

module.exports = { runMigrations };
