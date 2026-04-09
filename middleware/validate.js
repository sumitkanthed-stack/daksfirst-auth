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

  dealStatusUpdate: Joi.object({
    status: Joi.string().required(),
    internal_status: Joi.string()
  }),

  dealOnboarding: Joi.object({
    tab: Joi.string().valid('kyc', 'financials', 'valuation', 'refurbishment', 'exit_evidence', 'aml', 'insurance').required(),
    data: Joi.object().required()
  }),

  dealStageUpdate: Joi.object({
    stage: Joi.string().required()
  }),

  // Smart parse endpoints
  smartParseConfirm: Joi.object({
    parse_session_id: Joi.string().uuid().required(),
    deal_id: Joi.string().uuid(),
    parsed_data: Joi.object({
      borrower_name: Joi.string(),
      borrower_company: Joi.string(),
      borrower_email: Joi.string().email(),
      borrower_phone: Joi.string(),
      broker_name: Joi.string(),
      broker_company: Joi.string(),
      broker_fca: Joi.string(),
      security_address: Joi.string(),
      security_postcode: Joi.string(),
      asset_type: Joi.string(),
      current_value: Joi.number(),
      loan_amount: Joi.number(),
      ltv_requested: Joi.number(),
      loan_purpose: Joi.string(),
      exit_strategy: Joi.string(),
      term_months: Joi.number(),
      rate_requested: Joi.number(),
      additional_notes: Joi.string(),
      borrower_nationality: Joi.string(),
      borrower_type: Joi.string(),
      company_name: Joi.string(),
      company_number: Joi.string(),
      interest_servicing: Joi.string(),
      existing_charges: Joi.string(),
      property_tenure: Joi.string(),
      occupancy_status: Joi.string(),
      current_use: Joi.string(),
      purchase_price: Joi.number(),
      use_of_funds: Joi.string(),
      refurb_scope: Joi.string(),
      refurb_cost: Joi.number(),
      deposit_source: Joi.string()
    }).required()
  }),

  // Issue DIP
  issueDip: Joi.object({
    dip_notes: Joi.string(),
    dip_amount: Joi.number().positive(),
    dip_term_days: Joi.number().positive()
  }),

  // Credit decision
  creditDecision: Joi.object({
    decision: Joi.string().valid('approve', 'decline', 'more_info').required(),
    recommendation: Joi.string(),
    comments: Joi.string()
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

  // Borrower CRUD
  borrowerCreate: Joi.object({
    full_name: Joi.string().required(),
    role: Joi.string().valid('primary', 'joint', 'guarantor', 'director'),
    email: Joi.string().email(),
    phone: Joi.string().max(30),
    date_of_birth: Joi.date(),
    nationality: Joi.string(),
    jurisdiction: Joi.string(),
    address: Joi.string(),
    borrower_type: Joi.string().valid('individual', 'company'),
    company_name: Joi.string(),
    company_number: Joi.string()
  }),

  borrowerUpdate: Joi.object({
    full_name: Joi.string(),
    role: Joi.string().valid('primary', 'joint', 'guarantor', 'director'),
    email: Joi.string().email(),
    phone: Joi.string().max(30),
    date_of_birth: Joi.date(),
    nationality: Joi.string(),
    jurisdiction: Joi.string(),
    address: Joi.string(),
    borrower_type: Joi.string().valid('individual', 'company'),
    company_name: Joi.string(),
    company_number: Joi.string()
  }),

  // Property CRUD
  propertyCreate: Joi.object({
    address: Joi.string().required(),
    postcode: Joi.string().max(15),
    property_type: Joi.string().max(50),
    tenure: Joi.string().max(30),
    occupancy: Joi.string().max(30),
    current_use: Joi.string().max(50),
    market_value: Joi.number().positive(),
    purchase_price: Joi.number().positive(),
    gdv: Joi.number().positive(),
    reinstatement: Joi.number().positive(),
    day1_ltv: Joi.number().min(0).max(100),
    title_number: Joi.string().max(50),
    valuation_date: Joi.date(),
    insurance_sum: Joi.number().positive(),
    solicitor_firm: Joi.string().max(200),
    solicitor_ref: Joi.string().max(100),
    notes: Joi.string()
  }),

  propertyUpdate: Joi.object({
    address: Joi.string(),
    postcode: Joi.string().max(15),
    property_type: Joi.string().max(50),
    tenure: Joi.string().max(30),
    occupancy: Joi.string().max(30),
    current_use: Joi.string().max(50),
    market_value: Joi.number().positive(),
    purchase_price: Joi.number().positive(),
    gdv: Joi.number().positive(),
    reinstatement: Joi.number().positive(),
    day1_ltv: Joi.number().min(0).max(100),
    title_number: Joi.string().max(50),
    valuation_date: Joi.date(),
    insurance_sum: Joi.number().positive(),
    solicitor_firm: Joi.string().max(200),
    solicitor_ref: Joi.string().max(100),
    notes: Joi.string()
  }),

  // Broker onboarding
  brokerOnboarding: Joi.object({
    individual_name: Joi.string(),
    date_of_birth: Joi.date(),
    is_company: Joi.boolean(),
    company_name: Joi.string(),
    company_number: Joi.string(),
    bank_name: Joi.string(),
    bank_sort_code: Joi.string().length(6),
    bank_account_no: Joi.string().length(8),
    bank_account_name: Joi.string(),
    notes: Joi.string()
  }),

  // Law firms CRUD
  lawFirmCreate: Joi.object({
    firm_name: Joi.string().max(200).required(),
    contact_name: Joi.string().max(200),
    email: Joi.string().email(),
    phone: Joi.string().max(30),
    address: Joi.string(),
    notes: Joi.string()
  }),

  lawFirmUpdate: Joi.object({
    firm_name: Joi.string().max(200),
    contact_name: Joi.string().max(200),
    email: Joi.string().email(),
    phone: Joi.string().max(30),
    address: Joi.string(),
    notes: Joi.string()
  }),

  // Admin
  adminCreate: Joi.object({
    first_name: Joi.string().max(100).required(),
    last_name: Joi.string().max(100).required(),
    email: Joi.string().email().required(),
    phone: Joi.string().max(30).required(),
    role: Joi.string().valid('admin', 'rm', 'credit', 'compliance').required(),
    password: Joi.string().min(8).required()
  }),

  adminAssign: Joi.object({
    assigned_rm: Joi.number(),
    assigned_credit: Joi.number(),
    assigned_compliance: Joi.number()
  })
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
