require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { runMigrations } = require('./db/migrations');

// Import route files
const authRoutes = require('./routes/auth');
const dealsRoutes = require('./routes/deals');
const adminRoutes = require('./routes/admin');
const documentsRoutes = require('./routes/documents');
const borrowersRoutes = require('./routes/borrowers');
const propertiesRoutes = require('./routes/properties');
const brokerRoutes = require('./routes/broker');
const webhookRoutes = require('./routes/webhooks');
const smartParseRoutes = require('./routes/smart-parse');
const docusignWebhookRoutes = require('./routes/docusign-webhook');
const matrixRoutes = require('./routes/matrix');
const financialsRoutes = require('./routes/financials');
const companiesHouseRoutes = require('./routes/companies-house');
const riskRoutes = require('./routes/risk');
const pricingRoutes = require('./routes/pricing');
const hmlrRoutes = require('./routes/hmlr');
const { adminRouter: kycAdminRoutes, webhookRouter: smartsearchWebhookRoutes } = require('./routes/kyc');
const { adminRouter: creditAdminRoutes } = require('./routes/credit');
const panelsRoutes = require('./routes/panels');
const valuationsRoutes = require('./routes/valuations');
const balanceSheetRoutes = require('./routes/borrower-balance-sheet');
const directorshipsRoutes = require('./routes/directorships');

// Initialize Express app
const app = express();

// Set up trust proxy for rate limiting
app.set('trust proxy', 1);

// Middleware — capture rawBody for HMAC-verified webhooks (SmartSearch).
// Without the verify callback, downstream webhook handlers cannot reconstruct
// the exact bytes the vendor signed, so HMAC verification will silently fail.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,       // CSP handled by Vercel frontend; backend is API-only
  crossOriginEmbedderPolicy: false,   // Allow cross-origin API calls from frontend
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow Vercel to fetch from Render
  hsts: { maxAge: 31536000, includeSubDomains: true },   // Force HTTPS for 1 year
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// CORS configuration
app.use(cors({
  origin: config.CORS_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiters
const authLimiter = rateLimit(config.RATE_LIMITS.auth);
const dealLimiter = rateLimit(config.RATE_LIMITS.deals);
const adminLimiter = rateLimit(config.RATE_LIMITS.admin);

app.use('/api/auth', authLimiter);
app.use('/api/deals', dealLimiter);
app.use('/api/admin', adminLimiter);

// Health check
app.get('/api/health', async (req, res) => {
  const pool = require('./db/pool');
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (e) { /* ignore */ }
  // PTAL service — reports how many grid cells loaded, so we can verify the
  // TfL dataset is present without hitting a property endpoint.
  let ptalStatus = { loaded: false, cells: 0 };
  try { ptalStatus = require('./services/ptal').getStatus(); } catch (_) {}
  res.json({
    status: 'ok',
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    database: dbOk ? 'connected' : 'disconnected',
    webhook: config.N8N_WEBHOOK_URL ? 'configured' : 'not configured',
    onedrive: (config.AZURE_CLIENT_ID && config.AZURE_TENANT_ID && config.AZURE_CLIENT_SECRET) ? 'configured' : 'not configured',
    companies_house: config.COMPANIES_HOUSE_API_KEY ? 'configured' : 'not configured',
    chimnie: config.CHIMNIE_API_KEY ? 'configured' : 'not configured',
    ptal: ptalStatus.loaded ? `${ptalStatus.cells.toLocaleString()} cells loaded` : 'not loaded',
    hmlr: `mode=${config.HMLR_MODE}${(config.HMLR_USERNAME && config.HMLR_PASSWORD) ? ' creds=ok' : ' creds=missing'}${(config.HMLR_CLIENT_CERT && config.HMLR_CLIENT_KEY) ? ' cert=ok' : ' cert=missing'}`,
    smartsearch: `mode=${config.SMARTSEARCH_MODE}${(config.SMARTSEARCH_USERNAME && config.SMARTSEARCH_PASSWORD) ? ' creds=ok' : ' creds=missing'}${config.SMARTSEARCH_API_KEY ? ' apikey=ok' : ' apikey=missing'}${config.SMARTSEARCH_WEBHOOK_SECRET ? ' webhook=ok' : ' webhook=missing'}`,
    experian: `mode=${config.EXPERIAN_MODE || 'mock'}${(config.EXPERIAN_CLIENT_ID && config.EXPERIAN_CLIENT_SECRET) ? ' creds=ok' : ' creds=missing'}`
  });
});

// Route mounts
app.use('/api/auth', authRoutes);
app.use('/api/deals', dealsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', documentsRoutes);
app.use('/api/deals', borrowersRoutes);
app.use('/api/deals', propertiesRoutes);
app.use('/api', brokerRoutes);        // Mounts /broker/*, /staff/*, /law-firms/*, /admin/broker/*
app.use('/api/webhook', webhookRoutes);
app.use('/api/smart-parse', smartParseRoutes);
app.use('/api/docusign', docusignWebhookRoutes);
app.use('/api/matrix', matrixRoutes);
app.use('/api/deals', financialsRoutes);
app.use('/api/companies-house', companiesHouseRoutes);
app.use('/api', riskRoutes);          // Mounts /admin/risk-runs/start (token+internal) and /risk-callback (webhook secret)
app.use('/api', pricingRoutes);       // Mounts /admin/pricing/preview/:dealId + /admin/pricing/active-config (PRICE-3)
app.use('/api/admin/hmlr', hmlrRoutes); // HM Land Registry — admin-only (status, search, pull, property)
app.use('/api/admin/kyc', kycAdminRoutes); // SmartSearch KYC/AML — admin-only (status, individual, business, sanctions, sweep, monitor, checks, check)
app.use('/api/webhooks/smartsearch', smartsearchWebhookRoutes); // SmartSearch ongoing-monitoring webhook (HMAC-verified, public)
app.use('/api/admin/credit', creditAdminRoutes); // Experian credit bureau — admin-only (status, personal, business, hunter, sweep, checks, check, latest)
app.use('/api/admin/panels', panelsRoutes); // Approved valuer + lawyer panel CRUD — admin-only (Sprint 1b 2026-04-28)
app.use('/api/admin/valuations', valuationsRoutes); // RICS valuation evidence — admin-only Pattern B (Sprint 1b 2026-04-28)
app.use('/api/admin/balance-sheet', balanceSheetRoutes); // Per-UBO balance sheet — admin-only (Sprint 3 #17 2026-04-28)
app.use('/api/admin/directorships', directorshipsRoutes); // CH directorships KYC — admin-only (Sprint 3 #18 2026-04-28)

// Error handling
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
const PORT = config.PORT;

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`[daksfirst-auth] v${require('./package.json').version} running on port ${PORT}`);
    console.log(`[daksfirst-auth] CORS: ${config.CORS_ORIGINS.join(', ')}`);
    console.log(`[daksfirst-auth] Webhook: ${config.N8N_WEBHOOK_URL || 'NOT CONFIGURED'}`);
    console.log(`[daksfirst-auth] OneDrive: ${config.AZURE_CLIENT_ID ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
    console.log(`[daksfirst-auth] JWT Expiry: ${config.JWT_EXPIRY}, Refresh: ${config.JWT_REFRESH_EXPIRY}`);
  });
}).catch(err => {
  console.error('[startup] Migration failed:', err);
  process.exit(1);
});

module.exports = app;
