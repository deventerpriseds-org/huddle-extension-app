const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
function harness(handler) {
  const properties = new Map(); const calls = []; const logs = [];
  const p = { getProperty: k => properties.get(k) || null, setProperty: (k,v) => properties.set(k,String(v)), deleteProperty: k => properties.delete(k) };
  const context = vm.createContext({
    console: { log: x => logs.push(x), error: x => logs.push(x) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => crypto.randomUUID(), computeDigest: (_,s) => [...crypto.createHash('sha256').update(s).digest()] },
    PropertiesService: { getScriptProperties: () => p },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ScriptApp: { getOAuthToken: () => 'unit-test-token', getProjectTriggers: () => [] },
    UrlFetchApp: { fetch: (url, options) => { calls.push({url,options}); return handler(url,options,properties); } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => s }) }
  });
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs','utf8'), context);
  return { context, properties, calls, logs, run: code => vm.runInContext(code, context) };
}
const response = (status, value, headers = {}) => ({ getResponseCode: () => status, getContentText: () => JSON.stringify(value), getAllHeaders: () => headers });
test('429 persists cooldown and prevents any immediate retry', () => {
  const h = harness(() => response(429, {}, { 'Retry-After': '3600' }));
  assert.throws(() => h.run("googleCall('https://unit.invalid')"), /429/);
  assert.throws(() => h.run("googleCall('https://unit.invalid')"), /cooldown/);
  assert.equal(h.calls.length, 1);
  assert.ok(Number(h.properties.get('NEXT_GOOGLE_REQUEST_MS')) > Date.now() + 3500000);
});
test('prepares pending channel before registration; reuses unexpired watch without API call', () => {
  const h = harness((url, options, properties) => {
    const request = JSON.parse(options.payload);
    assert.ok(JSON.parse(properties.get('CHANNELS'))[request.id]);
    return response(200, { id: request.id, resourceId: 'resource1', expiration: request.expiration });
  });
  h.properties.set('RECEIVER_URL', 'https://eds-tools-api.azurewebsites.net/api/huddle-sbx-drive-notify');
  h.run('preparePublicConfig(); registerWatch(); registerWatch();');
  assert.equal(h.calls.length, 1);
  assert.ok(!h.logs.join('').includes(h.properties.get('TOKEN')));
});
test('deduplicates Event ID plus Version persistently and coalesces rapid reads', () => {
  const row = ['message1','EDS-Outlook-PowerAutomate','new_email','2026-11-07T16:34:29Z','received','Low','HUDDLE-PA-SBX-unit','Generate test reply','2026-11-07T16:34:47Z','1','unit'];
  const h = harness(() => response(200, {values: [['headers'], row]}));
  assert.equal(h.run('readNewEvents().events.length'), 1);
  assert.equal(h.run('readNewEvents().deferred'), true);
  h.properties.set('LAST_READ_MS','0');
  assert.equal(h.run('readNewEvents().events.length'), 0);
  row[9] = '2'; h.properties.set('LAST_READ_MS','0');
  assert.equal(h.run('readNewEvents().events.length'), 1);
});
test('invalid callbacks cannot read the Sheet and duplicate callbacks do not read it twice', () => {
  const h = harness(() => response(200, {values: []}));
  h.run('preparePublicConfig()');
  const id = h.properties.get('CHANNEL_PREFIX') + '-test';
  h.properties.set('CHANNELS', JSON.stringify({[id]: {id, expiration: Date.now()+100000,resourceId:'resource1'}}));
  const payload = {auth:h.properties.get('TOKEN'),received_utc:new Date().toISOString(),headers:{'x-goog-channel-id':id,'x-goog-resource-id':'resource1','x-goog-resource-state':'update','x-goog-message-number':'5'}};
  h.context.request = {postData:{contents:JSON.stringify({...payload,auth:'wrong'})}};
  assert.equal(JSON.parse(h.run('doPost(request)')).ok, false);
  assert.equal(h.calls.length, 0);
  h.context.request.postData.contents = JSON.stringify(payload);
  assert.equal(JSON.parse(h.run('doPost(request)')).ok, true);
  assert.equal(JSON.parse(h.run('doPost(request)')).duplicate, true);
  assert.equal(h.calls.length, 1);
  assert.ok(!h.properties.get('EVIDENCE').includes(payload.auth));
});
