/**
 * SmartNotify Queue Engine
 * In-memory queue with retry logic, exponential backoff,
 * HMAC signature verification — production patterns
 */
const axios   = require('axios');
const crypto  = require('crypto');
const cron    = require('node-cron');
const { Event, Webhook, Notification } = require('../models');

const MAX_RETRY   = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS)     || 5000;

// ── In-memory queue ───────────────────────────────────────────
class NotificationQueue {
  constructor() {
    this.queue      = [];
    this.processing = false;
    this.stats      = { processed: 0, delivered: 0, failed: 0, retried: 0 };
  }

  enqueue(job) {
    this.queue.push({ ...job, enqueuedAt: new Date() });
    if (!this.processing) this.processNext();
  }

  async processNext() {
    if (this.queue.length === 0) { this.processing = false; return; }
    this.processing = true;
    const job = this.queue.shift();
    try {
      await this.deliver(job);
    } catch (err) {
      console.error('Queue error:', err.message);
    }
    setImmediate(() => this.processNext());
  }

  // ── HMAC signature (Salesforce-style webhook security) ──────
  generateSignature(secret, payload) {
    return 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  // ── Deliver with retry ───────────────────────────────────────
  async deliver(job, attempt = 1) {
    const { notificationId, targetUrl, payload, secret } = job;

    const notification = await Notification.findById(notificationId);
    if (!notification) return;

    const signature = this.generateSignature(secret, payload);

    try {
      const response = await axios.post(targetUrl, payload, {
        timeout: 10000,
        headers: {
          'Content-Type':       'application/json',
          'X-SmartNotify-Sig':  signature,
          'X-SmartNotify-Time': Date.now().toString(),
          'User-Agent':         'SmartNotify-Webhook/1.0',
        },
      });

      // ── Success ──────────────────────────────────────────────
      await Notification.findByIdAndUpdate(notificationId, {
        status:      'delivered',
        statusCode:  response.status,
        responseBody:JSON.stringify(response.data).slice(0, 500),
        deliveredAt: new Date(),
        attempts:    attempt,
      });

      await Webhook.findByIdAndUpdate(job.webhookId, {
        $inc: { successCount: 1 },
        lastTriggeredAt: new Date(),
      });

      this.stats.delivered++;
      this.stats.processed++;
      console.log(`✅ Delivered to ${targetUrl} [${response.status}] attempt #${attempt}`);

    } catch (err) {
      const statusCode = err.response?.status || 0;
      console.log(`❌ Failed to deliver to ${targetUrl} [${statusCode}] attempt #${attempt}`);

      // ── Retry with exponential backoff ───────────────────────
      if (attempt < MAX_RETRY) {
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1); // 5s, 10s, 20s
        this.stats.retried++;
        console.log(`🔄 Retry #${attempt + 1} in ${delay / 1000}s`);

        await Notification.findByIdAndUpdate(notificationId, {
          attempts:   attempt,
          nextRetryAt: new Date(Date.now() + delay),
          error:       err.message,
        });

        setTimeout(() => this.deliver(job, attempt + 1), delay);
      } else {
        // ── Final failure ────────────────────────────────────────
        await Notification.findByIdAndUpdate(notificationId, {
          status:    'failed',
          statusCode,
          attempts:  attempt,
          error:     err.message,
        });

        await Webhook.findByIdAndUpdate(job.webhookId, {
          $inc: { failureCount: 1 }
        });

        this.stats.failed++;
        this.stats.processed++;
        console.log(`💀 Permanently failed after ${attempt} attempts`);
      }
    }
  }

  getStats() {
    return { ...this.stats, queueLength: this.queue.length };
  }
}

const queue = new NotificationQueue();

// ── Event Processor ───────────────────────────────────────────
const processEvent = async (eventId) => {
  const event = await Event.findById(eventId);
  if (!event) return;

  await Event.findByIdAndUpdate(eventId, { status: 'processing' });

  // Find all matching webhooks
  const webhooks = await Webhook.find({
    isActive: true,
    events:   { $in: [event.eventType, '*'] }, // '*' = all events
  });

  if (webhooks.length === 0) {
    await Event.findByIdAndUpdate(eventId, { status: 'completed', processedAt: new Date() });
    return;
  }

  // Create notification records + enqueue
  for (const webhook of webhooks) {
    const notification = await Notification.create({
      event:     eventId,
      webhook:   webhook._id,
      targetUrl: webhook.targetUrl,
      payload: {
        id:        event._id,
        eventType: event.eventType,
        timestamp: event.createdAt,
        data:      event.payload,
      },
    });

    queue.enqueue({
      notificationId: notification._id,
      webhookId:      webhook._id,
      targetUrl:      webhook.targetUrl,
      payload:        notification.payload,
      secret:         webhook.secret,
    });
  }

  await Event.findByIdAndUpdate(eventId, { status: 'completed', processedAt: new Date() });
  console.log(`📤 Event ${event.eventType} dispatched to ${webhooks.length} webhooks`);
};

// ── Cron: retry stuck notifications every 5 min ───────────────
cron.schedule('*/5 * * * *', async () => {
  const stuck = await Notification.find({
    status:     'pending',
    nextRetryAt:{ $lte: new Date() },
    attempts:   { $lt: MAX_RETRY },
  }).limit(50);

  for (const n of stuck) {
    const webhook = await Webhook.findById(n.webhook);
    if (webhook) {
      queue.enqueue({
        notificationId: n._id,
        webhookId:      webhook._id,
        targetUrl:      n.targetUrl,
        payload:        n.payload,
        secret:         webhook.secret,
      });
    }
  }

  if (stuck.length > 0) console.log(`🔄 Re-queued ${stuck.length} stuck notifications`);
});

module.exports = { queue, processEvent };
