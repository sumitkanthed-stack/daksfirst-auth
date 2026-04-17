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

// Initialize Express app
const app = express();

// Set up trust proxy for rate limiting
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '10mb' }));

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
  res.json({
    status: 'ok',
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    database: dbOk ? 'connected' : 'disconnected',
    webhook: config.N8N_WEBHOOK_URL ? 'configured' : 'not configured',
    onedrive: (config.AZURE_CLIENT_ID && config.AZURE_TENANT_ID && config.AZURE_CLIENT_SECRET) ? 'configured' : 'not configured'
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
