'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { inspect } = require('./HuddleDriveNotify/verify');
const token = 'synthetic-unit-test-only';
const config = { prefix: 'HUDDLE-SBX-test', tokenHash: createHash('sha256').update(token).digest('hex') };
const headers = { 'x-goog-channel-id': 'HUDDLE-SBX-test-channel1', 'x-goog-channel-token': token, 'x-goog-resource-id': 'resource1', 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' };
test('accepts a real callback shape before resource ID is bound, without logging token', () => {
  const result = inspect(headers, config, 1000);
  assert.equal(result.status, 200);
  assert.equal(result.receipt.received_utc, '1970-01-01T00:00:01.000Z');
  assert.ok(!JSON.stringify(result.receipt).includes(token));
});
test('rejects wrong or absent token and unknown channel', () => {
  assert.equal(inspect({ ...headers, 'x-goog-channel-token': 'wrong' }, config).status, 403);
  assert.equal(inspect({ ...headers, 'x-goog-channel-token': undefined }, config).status, 403);
  assert.equal(inspect({ ...headers, 'x-goog-channel-id': 'other' }, config).status, 403);
});
test('rejects mismatched resource, malformed message number, expired channel, missing configuration', () => {
  assert.equal(inspect(headers, { ...config, resourceId: 'other' }).status, 403);
  assert.equal(inspect({ ...headers, 'x-goog-message-number': '-1' }, config).status, 400);
  assert.equal(inspect({ ...headers, 'x-goog-channel-expiration': 'Thu, 01 Jan 1970 00:00:01 GMT' }, config, 2000).status, 410);
  assert.equal(inspect(headers, {}).status, 503);
});
test('retains exact notification headers including out-of-order message numbers', () => {
  const result = inspect({ ...headers, 'x-goog-message-number': '3', 'x-goog-changed': 'content,properties' }, config);
  assert.equal(result.receipt.headers['x-goog-message-number'], '3');
  assert.equal(result.receipt.headers['x-goog-changed'], 'content,properties');
});
