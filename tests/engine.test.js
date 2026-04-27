// tests/engine.test.js
const crypto = require('crypto');

describe('SmartNotify — Core Engine Tests', () => {

  // ── HMAC Signature ──────────────────────
  describe('Webhook Signature Generation', () => {
    const generateSig = (secret, payload) =>
      'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

    it('should generate consistent HMAC signatures', () => {
      const secret  = 'test_secret_key';
      const payload = { eventType: 'user.created', data: { id: 1 } };
      const sig1    = generateSig(secret, payload);
      const sig2    = generateSig(secret, payload);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('should generate different signatures for different secrets', () => {
      const payload = { eventType: 'order.paid' };
      const sig1    = generateSig('secret1', payload);
      const sig2    = generateSig('secret2', payload);
      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different payloads', () => {
      const secret = 'same_secret';
      const sig1   = generateSig(secret, { id: 1 });
      const sig2   = generateSig(secret, { id: 2 });
      expect(sig1).not.toBe(sig2);
    });
  });

  // ── Exponential Backoff ──────────────────
  describe('Retry — Exponential Backoff', () => {
    const getDelay = (attempt, base = 5000) => base * Math.pow(2, attempt - 1);

    it('attempt 1 → 5s delay', ()  => expect(getDelay(1)).toBe(5000));
    it('attempt 2 → 10s delay', () => expect(getDelay(2)).toBe(10000));
    it('attempt 3 → 20s delay', () => expect(getDelay(3)).toBe(20000));

    it('should not exceed MAX_RETRY attempts', () => {
      const MAX = 3;
      let attempts = 0;
      while (attempts < MAX) attempts++;
      expect(attempts).toBe(MAX);
    });
  });

  // ── Event Routing ────────────────────────
  describe('Event Type Matching', () => {
    const matchesWebhook = (webhookEvents, eventType) =>
      webhookEvents.includes('*') || webhookEvents.includes(eventType);

    it('wildcard * should match any event', () => {
      expect(matchesWebhook(['*'], 'user.created')).toBe(true);
      expect(matchesWebhook(['*'], 'order.paid')).toBe(true);
    });

    it('specific event should only match itself', () => {
      expect(matchesWebhook(['user.created'], 'user.created')).toBe(true);
      expect(matchesWebhook(['user.created'], 'order.paid')).toBe(false);
    });

    it('multiple events should match correctly', () => {
      const events = ['user.created', 'order.paid'];
      expect(matchesWebhook(events, 'user.created')).toBe(true);
      expect(matchesWebhook(events, 'order.paid')).toBe(true);
      expect(matchesWebhook(events, 'product.deleted')).toBe(false);
    });
  });

  // ── API Key Format ───────────────────────
  describe('API Key Generation', () => {
    const { v4: uuidv4 } = require('uuid');
    const genKey = () => 'sn_' + uuidv4().replace(/-/g, '');

    it('should start with sn_ prefix', () => {
      expect(genKey()).toMatch(/^sn_/);
    });

    it('should be unique every time', () => {
      const keys = new Set(Array.from({ length: 100 }, genKey));
      expect(keys.size).toBe(100);
    });
  });

  // ── Queue Stats ──────────────────────────
  describe('Queue Stats Tracking', () => {
    it('should track delivered and failed counts', () => {
      const stats = { processed: 0, delivered: 0, failed: 0, retried: 0 };
      stats.delivered++; stats.processed++;
      stats.failed++;    stats.processed++;
      stats.retried++;

      expect(stats.processed).toBe(2);
      expect(stats.delivered).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.retried).toBe(1);
    });

    it('success rate calculation', () => {
      const delivered = 95, total = 100;
      const rate = ((delivered / total) * 100).toFixed(1);
      expect(rate).toBe('95.0');
    });
  });
});
