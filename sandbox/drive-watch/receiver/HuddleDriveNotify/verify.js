'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const HEADER_NAMES = ['x-goog-channel-id', 'x-goog-resource-id', 'x-goog-resource-state', 'x-goog-message-number', 'x-goog-changed', 'x-goog-channel-expiration'];
function inspect(headers, config, now = Date.now()) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!config.prefix || !/^[a-f0-9]{64}$/.test(config.tokenHash || '')) return { status: 503 };
  const digest = createHash('sha256').update(h['x-goog-channel-token'] || '').digest();
  if (!timingSafeEqual(digest, Buffer.from(config.tokenHash, 'hex'))) return { status: 403 };
  const channel = h['x-goog-channel-id'] || '';
  if (!channel.startsWith(config.prefix + '-') || channel.length > 128) return { status: 403 };
  if (!h['x-goog-resource-id'] || !h['x-goog-resource-state'] || !/^\d+$/.test(h['x-goog-message-number'] || '')) return { status: 400 };
  if (config.resourceId && h['x-goog-resource-id'] !== config.resourceId) return { status: 403 };
  const expiry = Date.parse(h['x-goog-channel-expiration'] || '');
  if (Number.isFinite(expiry) && expiry <= now) return { status: 410 };
  if (HEADER_NAMES.some(k => (h[k] || '').length > 1000)) return { status: 400 };
  return { status: 200, receipt: { received_utc: new Date(now).toISOString(), headers: Object.fromEntries(HEADER_NAMES.filter(k => h[k]).map(k => [k, h[k]])) } };
}
module.exports = { inspect };
