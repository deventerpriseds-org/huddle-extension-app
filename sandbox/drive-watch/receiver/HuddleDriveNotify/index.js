'use strict';
const { inspect } = require('./verify');
const sandbox = require('./sandbox-config.json');
module.exports = async function (context, req) {
  const result = inspect(req.headers, {
    prefix: (process.env.HUDDLE_SBX_CHANNEL_PREFIX || sandbox.CHANNEL_PREFIX),
    tokenHash: (process.env.HUDDLE_SBX_TOKEN_SHA256 || sandbox.TOKEN_SHA256),
    resourceId: (process.env.HUDDLE_SBX_RESOURCE_ID || sandbox.RESOURCE_ID)
  });
  if (result.status !== 200) { context.res = { status: result.status, body: '' }; return; }
  // Only this sanitized envelope reaches Azure logs. Never log the channel token, URL or body.
  context.log(JSON.stringify({ source: 'google-drive-live', ...result.receipt }));
  const url = (process.env.HUDDLE_SBX_APPS_SCRIPT_URL || sandbox.APPS_SCRIPT_URL) || '';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    context.log.error('HUDDLE_SBX_APPS_SCRIPT_URL missing or invalid');
    context.res = { status: 503, body: '' }; return;
  }
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...result.receipt, auth: req.headers['x-goog-channel-token'] }),
      signal: AbortSignal.timeout(8000)
    });
    const answer = await response.json();
    if (!response.ok || answer.ok !== true) throw new Error('forward-not-accepted');
    context.res = { status: 200, body: '' };
  } catch {
    // A retry cannot duplicate an event: Apps Script persists Event ID + Version under a lock.
    context.log.error('Drive receipt forward failed; scheduled reconciliation is the backstop');
    context.res = { status: 503, body: '' };
  }
};
