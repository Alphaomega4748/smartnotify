const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const compression= require('compression');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const dotenv     = require('dotenv');
const path       = require('path');

dotenv.config();

const app = express();

// ── Security & Performance ────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// ── Rate Limiting ─────────────────────────
app.use('/api/auth', rateLimit({ windowMs: 60000, max: 20, message: { success: false, message: 'Too many requests' } }));
app.use('/api/',     rateLimit({ windowMs: 60000, max: 300 }));

// ── MongoDB ───────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/smartnotify', {
  maxPoolSize: 10,
})
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB:', err));

// ── Routes ────────────────────────────────
app.use('/api', require('./routes'));

// ── Dashboard UI ──────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Health ────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status:  'OK',
  service: 'SmartNotify v1.0',
  uptime:  `${Math.floor(process.uptime())}s`,
  memory:  `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
}));

// ── 404 ───────────────────────────────────
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// ── Error Handler ─────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 SmartNotify running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
