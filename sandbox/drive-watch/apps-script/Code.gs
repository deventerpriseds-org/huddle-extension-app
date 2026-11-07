// Isolated synthetic-file helper. The file ID is deliberately fixed, never supplied by a caller.
const FILE_ID = '1E5amZw1z4FXz-JckCYKul41JHhYJY1pK6ERQm7rHCK0';
const P = () => PropertiesService.getScriptProperties();
function digest(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function json(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function cooldown() {
  if (Date.now() < Number(P().getProperty('NEXT_GOOGLE_REQUEST_MS') || 0)) throw new Error('Google cooldown active; no API request sent');
}
function googleCall(url, options) {
  cooldown();
  const response = UrlFetchApp.fetch(url, Object.assign({}, options || {}, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  }));
  const status = response.getResponseCode();
  if (status === 429 || status >= 500) {
    const headers = response.getAllHeaders();
    const retry = headers['Retry-After'] || headers['retry-after'];
    const wait = /^\d+$/.test(String(retry || '')) ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now();
    P().setProperty('NEXT_GOOGLE_REQUEST_MS', String(Date.now() + Math.max(15 * 60000, Number.isFinite(wait) ? wait : 0)));
    throw new Error('Google request stopped: HTTP ' + status + '; cooldown persisted; no inline retry');
  }
  if (status < 200 || status >= 300) throw new Error('Google request rejected: HTTP ' + status);
  return JSON.parse(response.getContentText());
}
function preparePublicConfig() {
  const p = P();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('CHANNEL_PREFIX')) p.setProperty('CHANNEL_PREFIX', 'HUDDLE-SBX-' + Utilities.getUuid());
  console.log(JSON.stringify({ file_id: FILE_ID, channel_prefix: p.getProperty('CHANNEL_PREFIX'), token_sha256: digest(p.getProperty('TOKEN')) }));
}
function registerWatch() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { registerLocked(); } finally { lock.releaseLock(); }
}
function registerLocked() {
  cooldown();
  const p = P();
  const active = JSON.parse(p.getProperty('ACTIVE_CHANNEL') || 'null');
  if (active && Number(active.expiration) > Date.now() + 3600000) { console.log('Existing channel retained; no watch API request'); return; }
  const receiver = p.getProperty('RECEIVER_URL') || '';
  if (!/^https:\/\/[a-z0-9-]+\.azurewebsites\.net\/api\/huddle-sbx-drive-notify$/.test(receiver)) throw new Error('Set an approved EDS RECEIVER_URL before registering');
  if (!p.getProperty('TOKEN') || !p.getProperty('CHANNEL_PREFIX')) throw new Error('Run preparePublicConfig first');
  const id = p.getProperty('CHANNEL_PREFIX') + '-' + Utilities.getUuid();
  const pending = { id: id, expiration: String(Date.now() + 23 * 3600000), resourceId: null };
  // Persist BEFORE registration: Google's initial sync may beat the response.
  const channels = JSON.parse(p.getProperty('CHANNELS') || '{}'); channels[id] = pending;
  Object.keys(channels).forEach(k => { if (Number(channels[k].expiration) < Date.now() - 3600000) delete channels[k]; });
  p.setProperty('CHANNELS', JSON.stringify(channels));
  const result = googleCall('https://www.googleapis.com/drive/v3/files/' + FILE_ID + '/watch', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ id: id, type: 'web_hook', address: receiver, token: p.getProperty('TOKEN'), expiration: pending.expiration })
  });
  channels[id] = { id: result.id, resourceId: result.resourceId, expiration: result.expiration };
  p.setProperty('CHANNELS', JSON.stringify(channels)); p.setProperty('ACTIVE_CHANNEL', JSON.stringify(channels[id]));
  console.log(JSON.stringify({ operation: 'files.watch', file_id: FILE_ID, registration: channels[id] }));
}
function appendEvidence(entry) {
  const p = P(); const evidence = JSON.parse(p.getProperty('EVIDENCE') || '[]');
  evidence.push(entry);
  while (evidence.length > 1 && JSON.stringify(evidence).length > 8000) evidence.shift();
  const encoded = JSON.stringify(evidence);
  if (encoded.length > 8000) throw new Error('Evidence exceeds bounded sandbox storage');
  p.setProperty('EVIDENCE', encoded);
}
function readNewEvents() {
  const p = P();
  // Coalesce bursts and overlapping renewal channels. Periodic reconciliation catches a skipped read.
  if (Date.now() - Number(p.getProperty('LAST_READ_MS') || 0) < 15000) return { deferred: true, events: [] };
  const data = googleCall('https://sheets.googleapis.com/v4/spreadsheets/' + FILE_ID + '/values/Events!A1:K101');
  p.setProperty('LAST_READ_MS', String(Date.now()));
  const ledger = JSON.parse(p.getProperty('EVENT_LEDGER') || '[]');
  const seen = new Set(ledger); const fresh = [];
  (data.values || []).slice(1).forEach(row => {
    if (row[1] !== 'EDS-Outlook-PowerAutomate' || !String(row[6] || '').startsWith('HUDDLE-PA-SBX-')) return;
    const key = digest(String(row[0]) + '|' + String(row[9]));
    if (!seen.has(key)) { seen.add(key); ledger.push(key); fresh.push({ event_id: row[0], version: row[9], subject: row[6], received_utc: row[3], write_requested_utc: row[8], notes: row[10], ingested_utc: new Date().toISOString() }); }
  });
  p.setProperty('EVENT_LEDGER', JSON.stringify(ledger.slice(-100)));
  return { deferred: false, events: fresh };
}
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(4000)) return json({ ok: false, reason: 'busy' });
  try {
    const body = JSON.parse(e.postData.contents || '{}'); const p = P();
    if (!p.getProperty('TOKEN') || digest(body.auth || '') !== digest(p.getProperty('TOKEN'))) return json({ ok: false });
    const h = body.headers || {}; const id = h['x-goog-channel-id'];
    const channels = JSON.parse(p.getProperty('CHANNELS') || '{}'); const channel = channels[id];
    if (!channel || Number(channel.expiration) <= Date.now()) return json({ ok: false });
    if (channel.resourceId && channel.resourceId !== h['x-goog-resource-id']) return json({ ok: false });
    const receiptKey = digest(id + '|' + h['x-goog-message-number']);
    const seen = JSON.parse(p.getProperty('RECEIPT_LEDGER') || '[]');
    if (seen.includes(receiptKey)) return json({ ok: true, duplicate: true });
    const record = { azure_received_utc: body.received_utc, helper_received_utc: new Date().toISOString(), headers: h };
    try { record.reconciliation = readNewEvents(); } catch (error) { record.reconciliation_error = String(error.message); }
    // Persist receipt before acknowledging. Do not assume message numbers are consecutive or ordered.
    appendEvidence(record); seen.push(receiptKey); p.setProperty('RECEIPT_LEDGER', JSON.stringify(seen.slice(-100)));
    console.log(JSON.stringify(record)); return json({ ok: true });
  } catch (error) { console.error('Synthetic webhook processing failed'); return json({ ok: false }); }
  finally { lock.releaseLock(); }
}
function maintainWatchAndReconcile() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(4000)) return;
  try {
    registerLocked();
    const result = readNewEvents();
    if (result.events.length) appendEvidence({ recovery_utc: new Date().toISOString(), reconciliation: result });
  } finally { lock.releaseLock(); }
}
function enableMaintenance() {
  // Explicit setup only. Never install more than one timer.
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'maintainWatchAndReconcile')) ScriptApp.newTrigger('maintainWatchAndReconcile').timeBased().everyMinutes(5).create();
}
function showEvidence() { console.log(P().getProperty('ACTIVE_CHANNEL')); console.log(P().getProperty('EVIDENCE') || '[]'); }
function stopSandboxWatch() {
  const p = P(); const channels = JSON.parse(p.getProperty('CHANNELS') || '{}');
  Object.keys(channels).forEach(id => {
    if (channels[id].resourceId) {
      cooldown();
      const response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/channels/stop', { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify({ id: id, resourceId: channels[id].resourceId }), muteHttpExceptions: true });
      if (![200, 204, 404].includes(response.getResponseCode())) throw new Error('Channel stop failed; retained for retry');
    }
    delete channels[id]; p.setProperty('CHANNELS', JSON.stringify(channels));
  });
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'maintainWatchAndReconcile').forEach(t => ScriptApp.deleteTrigger(t));
  p.deleteProperty('ACTIVE_CHANNEL');
}
