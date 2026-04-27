const mongoose = require('mongoose');

// ── Webhook Subscription ──────────────────────────────────────
const webhookSchema = new mongoose.Schema({
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:        { type: String, required: true, trim: true },
  targetUrl:   { type: String, required: true },   // URL to deliver payload
  secret:      { type: String, required: true },    // HMAC signing secret
  events:      [{ type: String }],                  // ['user.created', 'order.paid']
  isActive:    { type: Boolean, default: true },
  successCount:{ type: Number, default: 0 },
  failureCount:{ type: Number, default: 0 },
  lastTriggeredAt: { type: Date },
}, { timestamps: true });

// ── Incoming Event ────────────────────────────────────────────
const eventSchema = new mongoose.Schema({
  eventType:  { type: String, required: true },     // 'user.created'
  source:     { type: String, default: 'api' },     // who triggered
  payload:    { type: mongoose.Schema.Types.Mixed }, // event data
  status:     { type: String, enum: ['queued','processing','completed','failed'], default: 'queued' },
  processedAt:{ type: Date },
}, { timestamps: true });

// ── Notification Delivery Log ─────────────────────────────────
const notificationSchema = new mongoose.Schema({
  event:        { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  webhook:      { type: mongoose.Schema.Types.ObjectId, ref: 'Webhook', required: true },
  targetUrl:    { type: String, required: true },
  payload:      { type: mongoose.Schema.Types.Mixed },
  status:       { type: String, enum: ['pending','delivered','failed'], default: 'pending' },
  statusCode:   { type: Number },
  responseBody: { type: String },
  attempts:     { type: Number, default: 0 },
  nextRetryAt:  { type: Date },
  deliveredAt:  { type: Date },
  error:        { type: String },
}, { timestamps: true });

// ── User ──────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  apiKey:   { type: String, unique: true },   // for webhook auth
  plan:     { type: String, enum: ['free','pro'], default: 'free' },
}, { timestamps: true });

const Webhook      = mongoose.model('Webhook',      webhookSchema);
const Event        = mongoose.model('Event',        eventSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const User         = mongoose.model('User',         userSchema);

module.exports = { Webhook, Event, Notification, User };
