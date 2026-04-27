const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { User, Webhook, Event, Notification } = require('../models');
const { protect }       = require('../middleware/auth');
const { processEvent, queue } = require('../queue/engine');

const router = express.Router();
const sign   = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// ══════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════

// POST /api/auth/register
router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, message: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const apiKey = 'sn_' + uuidv4().replace(/-/g, '');
    const user   = await User.create({ name, email, password: hashed, apiKey });

    res.status(201).json({ success: true, token: sign(user._id), apiKey: user.apiKey,
      user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    res.json({ success: true, token: sign(user._id), apiKey: user.apiKey,
      user: { id: user._id, name: user.name, email: user.email } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════
// WEBHOOKS
// ══════════════════════════════════════════

// POST /api/webhooks — Register a webhook
router.post('/webhooks', protect, async (req, res) => {
  try {
    const { name, targetUrl, events = ['*'] } = req.body;
    if (!name || !targetUrl)
      return res.status(400).json({ success: false, message: 'name and targetUrl required' });

    const secret  = crypto.randomBytes(32).toString('hex');
    const webhook = await Webhook.create({ owner: req.user._id, name, targetUrl, events, secret });

    res.status(201).json({ success: true, webhook: { ...webhook.toObject(), secret },
      message: 'Save this secret — it won\'t be shown again!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/webhooks — List my webhooks
router.get('/webhooks', protect, async (req, res) => {
  try {
    const webhooks = await Webhook.find({ owner: req.user._id })
      .select('-secret').sort({ createdAt: -1 });
    res.json({ success: true, count: webhooks.length, webhooks });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/webhooks/:id — Get webhook details
router.get('/webhooks/:id', protect, async (req, res) => {
  try {
    const webhook = await Webhook.findOne({ _id: req.params.id, owner: req.user._id }).select('-secret');
    if (!webhook) return res.status(404).json({ success: false, message: 'Webhook not found' });
    res.json({ success: true, webhook });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PUT /api/webhooks/:id — Update webhook
router.put('/webhooks/:id', protect, async (req, res) => {
  try {
    const { name, targetUrl, events, isActive } = req.body;
    const webhook = await Webhook.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { name, targetUrl, events, isActive },
      { new: true }
    ).select('-secret');
    if (!webhook) return res.status(404).json({ success: false, message: 'Webhook not found' });
    res.json({ success: true, webhook });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/webhooks/:id
router.delete('/webhooks/:id', protect, async (req, res) => {
  try {
    await Webhook.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
    res.json({ success: true, message: 'Webhook deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/webhooks/:id/rotate-secret — Rotate signing secret
router.post('/webhooks/:id/rotate-secret', protect, async (req, res) => {
  try {
    const newSecret = crypto.randomBytes(32).toString('hex');
    const webhook   = await Webhook.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { secret: newSecret },
      { new: true }
    );
    if (!webhook) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, secret: newSecret, message: 'Secret rotated. Update your endpoint.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════
// EVENTS  (trigger a webhook event)
// ══════════════════════════════════════════

// POST /api/events — Trigger an event
router.post('/events', protect, async (req, res) => {
  try {
    const { eventType, payload = {} } = req.body;
    if (!eventType)
      return res.status(400).json({ success: false, message: 'eventType is required' });

    const event = await Event.create({ eventType, payload, source: req.user.email });

    // Fire and forget — async processing
    setImmediate(() => processEvent(event._id));

    res.status(202).json({
      success: true,
      message: 'Event accepted and queued for delivery',
      eventId: event._id,
      eventType,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/events — List events
router.get('/events', protect, async (req, res) => {
  try {
    const { status, limit = 20, page = 1 } = req.query;
    const filter = status ? { status } : {};
    const events = await Event.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    const total = await Event.countDocuments(filter);
    res.json({ success: true, total, page: parseInt(page), events });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════
// NOTIFICATIONS (delivery logs)
// ══════════════════════════════════════════

// GET /api/notifications
router.get('/notifications', protect, async (req, res) => {
  try {
    const { status, webhookId, limit = 20, page = 1 } = req.query;
    const filter = {};
    if (status)    filter.status  = status;
    if (webhookId) filter.webhook = webhookId;

    const notifications = await Notification.find(filter)
      .populate('event', 'eventType createdAt')
      .populate('webhook', 'name targetUrl')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Notification.countDocuments(filter);
    res.json({ success: true, total, notifications });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/notifications/:id/retry — Manual retry
router.post('/notifications/:id/retry', protect, async (req, res) => {
  try {
    const n = await Notification.findById(req.params.id);
    if (!n) return res.status(404).json({ success: false, message: 'Not found' });
    if (n.status === 'delivered')
      return res.status(400).json({ success: false, message: 'Already delivered' });

    const webhook = await Webhook.findById(n.webhook);
    queue.enqueue({ notificationId: n._id, webhookId: webhook._id, targetUrl: n.targetUrl, payload: n.payload, secret: webhook.secret });

    await Notification.findByIdAndUpdate(req.params.id, { status: 'pending', nextRetryAt: new Date() });
    res.json({ success: true, message: 'Retry queued' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════════
// DASHBOARD STATS
// ══════════════════════════════════════════

router.get('/dashboard', protect, async (req, res) => {
  try {
    const webhookCount = await Webhook.countDocuments({ owner: req.user._id });
    const [delivered, failed, pending, total] = await Promise.all([
      Notification.countDocuments({ status: 'delivered' }),
      Notification.countDocuments({ status: 'failed' }),
      Notification.countDocuments({ status: 'pending' }),
      Notification.countDocuments(),
    ]);

    const recentEvents = await Event.find()
      .sort({ createdAt: -1 }).limit(5);

    const successRate = total > 0 ? ((delivered / total) * 100).toFixed(1) : '0';

    res.json({
      success: true,
      stats: { webhookCount, delivered, failed, pending, total, successRate: `${successRate}%` },
      queueStats:   queue.getStats(),
      recentEvents,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
