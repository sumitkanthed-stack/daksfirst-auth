const Joi = require('joi');

// Joi schemas for validation
const schemas = {
  // Auth endpoints
  register: Joi.object({
    role: Joi.string().valid('broker', 'borrower').required(),
    first_name: Joi.string().max(100).required(),
    last_name: Joi.string().max(100).required(),
    email: Joi.string().email().required(),
    phone: Joi.string().max(30).required(),
    password: Joi.string().min(8).required(),
    company: Joi.string().max(200),
    fca_number: Joi.string().max(50),
    loan_purpose: Joi.string().max(100),
    loan_amount: Joi.number().positive(),
    source: Joi.string().max(50)
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  }),

  verify: Joi.object({
    token: Joi.string().required()
  }),

  refreshToken: Joi.object({
    refresh_token: Joi.string().required()
  }),

  // Deal endpoints
  dealSubmit: Joi.object({
    security_address: Joi.string().required(),
    security_postcode: Joi.string().max(15),
    loan_amount: Joi.number().positive().required(),
    loan_purpose: Joi.string().required(),
    borrower_name: Joi.string().max(200),
    borrower_company: Joi.string().max(200),
    borrower_email: Joi.string().email(),
    borrower_phone: Joi.string().max(30),
    broker_name: Joi.string().max(200),
    broker_company: Joi.string().max(200),
    broker_fca: Joi.string().max(50),
    asset_type: Joi.string().max(50),
    current_value: Joi.number().positive(),
    ltv_requested: Joi.number().min(0).max(100),
    exit_strategy: Joi.string(),
    term_months: Joi.number().positive(),
    rate_requested: Joi.number().positive(),
    additional_notes: Joi.string(),
    documents: Joi.array().items(Joi.object()),
    borrower_dob: Joi.date(),
    borrower_nationality: Joi.string().max(100),
    borrower_jurisdiction: Joi.string().max(100),
    borrower_type: Joi.string().max(50),
    company_name: Joi.string().max(200),
    company_number: Joi.string().max(50),
    drawdown_date: Joi.date(),
    interest_servicing: Joi.string().max(30),
    existing_charges: Joi.string(),
    property_tenure: Joi.string().max(30),
    occupancy_status: Joi.string().max(30),
    current_use: Joi.string().max(50),
    purchase_price: Joi.number().positive(),
    use_of_funds: Joi.string(),
    refurb_scope: Joi.string(),
    refurb_cost: Joi.number().positive(),
    deposit_source: Joi.string(),
    concurrent_transactions: Joi.string(),
    borrower_invite_email: Joi.string().email()
  }),

  dealOnboarding: Joi.object({
    tab: Joi.string().valid('kyc', 'financials', 'valuation', 'refurbishment', 'exit_evidence', 'aml', 'insurance').required(),
    data: Joi.object().required()
  }),

  dealStageUpdate: Joi.object({
    stage: Joi.string().required()
  }),

  // Issue DIP
  issueDip: Joi.object({
    notes: Joi.string().allow('', null),
    dip_data: Joi.object({
      loan_amount: Joi.number().positive(),
      property_value: Joi.number().positive(),
      ltv: Joi.number().min(0).max(100),
      term_months: Joi.number().positive(),
      rate_monthly: Joi.number().positive(),
      interest_servicing: Joi.string(),
      exit_strategy: Joi.string(),
      arrangement_fee: Joi.number().min(0),
      broker_fee: Joi.number().min(0),
      valuation_cost: Joi.number().min(0),
      legal_cost: Joi.number().min(0),
      fee_onboarding: Joi.number().min(0),
      fee_commitment: Joi.number().min(0),
      retained_months: Joi.number().min(0),
      fixed_charge: Joi.string(),
      pg_ubo: Joi.string(),
      additional_security: Joi.string().allow('', null),
      ubo_names: Joi.string().allow('', null),
      notes: Joi.string().allow('', null)
    }).unknown(true) // allow extra fields like property valuations
  }).unknown(true),

  // Credit decision
  creditDecision: Joi.object({
    decision: Joi.string().valid('approve', 'decline', 'moreinfo').required(),
    notes: Joi.string().allow('', null),
    conditions: Joi.string().allow('', null),
    next_stage: Joi.string().allow('', null),
    retained_months: Joi.number().min(0).max(36).allow(null),
    override_rate: Joi.number().min(0).max(5).allow(null),
    override_ltv: Joi.number().min(0).max(80).allow(null),
    override_arr_fee: Joi.number().min(0).max(10).allow(null),
  }),

  // Request fee
  requestFee: Joi.object({
    fee_amount: Joi.number().positive().required(),
    fee_type: Joi.string().required()
  }),

  // Fee confirmation
  feeConfirm: Joi.object({
    fee_type: Joi.string().required(),
    payment_ref: Joi.string().required(),
    amount: Joi.number().positive().required()
  }),

  // Bank submit
  bankSubmit: Joi.object({
    bank_reference: Joi.string()
  }),

  // Bank approve
  bankApprove: Joi.object({
    bank_approval_notes: Joi.string()
  }),

  // Borrower accept
  borrowerAccept: Joi.object({
    accepted: Joi.boolean().required(),
    borrower_notes: Joi.string()
  }),

  // Instruct legal
  instructLegal: Joi.object({
    lawyer_firm: Joi.string().required(),
    lawyer_email: Joi.string().email().required(),
    lawyer_contact: Joi.string(),
    lawyer_reference: Joi.string()
  }),

  // Invite borrower
  inviteBorrower: Joi.object({
    borrower_email: Joi.string().email().required()
  }),

};

// Middleware factory
function validate(schemaName) {
  return (req, res, next) => {
    if (!schemas[schemaName]) {
      return res.status(500).json({ error: 'Validation schema not found' });
    }

    const { error, value } = schemas[schemaName].validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const messages = error.details.map(d => d.message).join('; ');
      return res.status(400).json({ error: 'Validation failed', details: messages });
    }

    req.validated = value;
    next();
  };
}

module.exports = { validate, schemas };
