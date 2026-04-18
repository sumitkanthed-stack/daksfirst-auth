const pool = require('./pool');

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
      `ALTER TABLE deal_borrowers ADD COLUMN IF NOT EXISTS source_of_funds TEXT`
    ];
    for (const sql of personColumns) {
      try { await pool.query(sql); } catch (e) { /* column may already exist */ }
    }
    console.log('[migrate] ✓ deal_borrowers individual person columns added');

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
      `ALTER TABLE deal_properties ADD COLUMN IF NOT EXISTS epc_selected_lmk_key VARCHAR(100)`
    ];
    for (const sql of propertySearchColumns) {
      try { await pool.query(sql); } catch (e) { /* column may already exist */ }
    }
    console.log('[migrate] ✓ deal_properties property search columns added');

    console.log('[migrate] All tables and indexes created/updated successfully');
  } catch (err) {
    console.error('[migrate] Migration failed:', err.message);
    throw err;
  }
}

module.exports = { runMigrations };
