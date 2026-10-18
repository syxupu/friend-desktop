import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const requests = [];
let behavior = 'normal', serial = 0;
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-study' }] })); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text || '{}'); requests.push(body);
  const mode = behavior; behavior = 'normal';
  if (mode === 'fail') { res.writeHead(429).end(JSON.stringify({ error: { message: 'local test failure' } })); return; }
  const reply = `“第${++serial}次本机测试回复，我陪你检查学习进度。”`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (let i = 0; i < reply.length && !res.destroyed; i += 3) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.slice(i, i + 3) }, finish_reason: null }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, mode === 'slow' ? 250 : 45));
  }
  if (!res.destroyed) res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const mockUrl = `http://127.0.0.1:${server.address().port}/v1`;
const packaged = process.argv.includes('--packaged');
const noticesOnly = process.argv.includes('--notices-only');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const dataDirectory = path.resolve('.test-data', `chat-controls-${packaged ? 'packaged-' : ''}${Date.now()}`);
let app, page, tavern;
const checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };
const state = () => page.evaluate(() => window.friend.getState());
const messages = async () => (await state()).messages.filter(message => message.role !== 'notice');
async function assertNativePin(expected) {
  const deadline = Date.now() + 3000;
  let actual;
  do {
    actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')).isAlwaysOnTop());
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(actual, expected, 'Native always-on-top state did not settle');
}
async function wait(predicate, timeout = 100000) {
  const end = Date.now() + timeout;
  do { const value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 75)); } while (Date.now() < end);
  throw new Error(`State wait expired: ${(await state()).connection}`);
}
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}),
    args: packaged ? ['--integration-test'] : ['.', '--integration-test'],
    env: { ...process.env, FRIEND_TEST_DATA: dataDirectory, FRIEND_TEST_URL: mockUrl }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend, null, { timeout: 30000 });
  await wait(value => value.tavernReady || value.error);
  assert.equal((await state()).tavernReady, true, (await state()).error);
  tavern = app.windows().find(window => window.url().startsWith('http://127.0.0.1:'));
  assert.ok(tavern);
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, keepAwake: false }));
}
const row = message => page.locator(`article[data-message-id="${message.id}"]`);
async function edit(message, text) {
  await row(message).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#edit-text').fill(text); await page.locator('#save-edit').click();
  await page.locator('#message-editor').waitFor({ state: 'hidden' });
}
async function remove(message) {
  await row(message).getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('#confirm-delete').click(); await page.locator('#message-delete').waitFor({ state: 'hidden' });
}
async function regenerate(mode = 'normal') {
  behavior = mode;
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await wait(value => value.busy, 10000);
}
try {
  await launch(); assert.deepEqual(await messages(), []);
  if (!noticesOnly) {
  await page.locator('#pin-button').click(); await wait(value => value.settings.chatAlwaysOnTop);
  await assertNativePin(true);
  assert.equal(await page.locator('#pin-button').getAttribute('aria-pressed'), 'true');
  await page.locator('#pin-button').click(); await wait(value => !value.settings.chatAlwaysOnTop); await assertNativePin(false);
  await page.locator('#pin-button').click(); await wait(value => value.settings.chatAlwaysOnTop); await assertNativePin(true);
  record('pin controls native always-on-top and accessible button state');
  }
  // Retain genuine earlier state notices, then begin a new segment. No provider
  // key during the old break, so the fixture makes no automatic opening request.
  await page.evaluate(async () => {
    await window.friend.saveSettings({ deepseekKey: '' });
    await window.friend.control('start', '旧学习段');
    await window.friend.control('end');
    await window.friend.control('finish');
    await window.friend.saveSettings({ deepseekKey: 'test-key' });
  });
  await page.evaluate(() => window.friend.control('start', '聊天功能验收'));
  await page.evaluate(() => window.friend.send('问题甲')); await page.evaluate(() => window.friend.send('问题乙'));
  assert.equal((await messages()).length, 4); assert.equal((await state()).study.rounds, 2);
  assert.equal((await state()).study.mode, 'study');
  const displayed = await page.locator('#messages article').evaluateAll(rows => rows.map(row => ({
    notice: row.classList.contains('notice'), text: row.textContent, time: row.querySelector('time')?.getAttribute('datetime'),
  })));
  const firstConversation = displayed.findIndex(row => !row.notice);
  assert.ok(firstConversation > 0);
  assert.ok(displayed.slice(0, firstConversation).some(row => row.text.includes('本段学习结束')));
  assert.ok(displayed.slice(0, firstConversation).some(row => row.text.includes('任务已结束')));
  assert.ok(displayed.slice(0, firstConversation).every(row => row.notice && row.time));
  assert.ok(displayed.slice(firstConversation).every(row => !row.notice), 'Old notices moved below the new conversation');
  const elapsed = (await state()).study.elapsedMs;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok((await state()).study.elapsedMs > elapsed);
  record('after two rounds, study timer continues and timestamped old end notices stay before the new conversation');
  let list = await messages();
  await edit(list[0], '修改后的问题甲'); await edit(list[1], '“修改后的角色回复甲。”');
  list = await messages();
  assert.equal(list[0].text, '修改后的问题甲'); assert.equal(list[1].text, '“修改后的角色回复甲。”');
  assert.deepEqual(await tavern.evaluate(() => window.SillyTavern.getContext().chat.map(message => message.mes)), list.map(message => message.text));
  record('UI edits both user and assistant history in Tavern');
  const before = list.at(-1), requestCount = requests.length;
  await regenerate(); await wait(value => !value.busy);
  list = await messages(); assert.equal(list.length, 4); assert.notEqual(list.at(-1).text, before.text);
  assert.equal(requests.length, requestCount + 1); assert.equal((await state()).study.rounds, 2);
  const modelContext = JSON.stringify(requests.at(-1).messages);
  assert.ok(modelContext.includes('修改后的问题甲')); assert.ok(modelContext.includes('修改后的角色回复甲'));
  assert.ok(!modelContext.includes(before.text));
  record('regeneration replaces latest reply once, uses edited context, and does not count a round');
  const accepted = list.at(-1);
  await regenerate('fail'); await wait(value => !value.busy);
  assert.deepEqual((await messages()).at(-1), accepted);
  record('provider failure retains original reply');
  await regenerate('slow'); await wait(value => value.messages.some(message => message.pending && message.text.length > 0));
  assert.equal(await row((await messages())[0]).getByRole('button', { name: '编辑', exact: true }).isDisabled(), true);
  await page.locator('#stop-generation').click(); await wait(value => !value.busy);
  assert.deepEqual((await messages()).at(-1), accepted); assert.equal((await state()).study.rounds, 2);
  record('cancelled regeneration restores original and disables overlapping history actions');
  // Crash the isolated test runtime while the native generator has removed its old reply.
  await regenerate('slow'); await wait(value => value.messages.some(message => message.pending && message.text.length > 0));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:')).destroy());
  await wait(value => !value.busy && !value.tavernReady);
  await page.locator('#restart-tavern').click(); await wait(value => value.tavernReady && !value.configuring);
  tavern = app.windows().find(window => window.url().startsWith('http://127.0.0.1:'));
  assert.deepEqual((await messages()).at(-1), accepted);
  record('durable regeneration backup restores original after runtime crash and restart');
  // Checked persistence must reject a write without publishing its staged edit.
  list = await messages(); const user = list[0];
  await tavern.route('**/api/chats/save', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test"}' }));
  await row(user).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#edit-text').fill('不得提交的修改'); await page.locator('#save-edit').click();
  await page.locator('#edit-error').waitFor({ state: 'visible' });
  assert.equal((await messages())[0].text, user.text); await page.locator('#discard-edit').click();
  await tavern.unroute('**/api/chats/save');
  record('failed history persistence keeps original text and reports error inside editor');
  await remove(list[0]);
  let remaining = await messages(); assert.equal(remaining.length, 3); assert.equal(remaining[0].id, list[1].id);
  const staleRejected = await page.evaluate(async user => {
    try { await window.friend.changeMessage({ action: 'edit', id: user.id, expectedText: user.text, text: '过时操作' }); return false; } catch { return true; }
  }, user);
  assert.equal(staleRejected, true);
  await remove(remaining[0]);
  remaining = await messages(); assert.equal(remaining.length, 2); assert.equal(remaining[0].text, '问题乙');
  record('delete affects exactly one selected message on either side; stale IDs cannot target another row');
  assert.equal(await page.locator('#error').isVisible(), false, 'Recovered state clears old failure banner');
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: noticesOnly ? 'docs/screenshots/notice-order.png' : `docs/screenshots/chat-controls-${packaged ? 'packaged' : 'dev'}.png` });
  const saved = await messages(); await app.close(); app = null;
  await launch();
  assert.deepEqual(await messages(), saved);
  if (!noticesOnly) { assert.equal((await state()).settings.chatAlwaysOnTop, true); await assertNativePin(true); }
  record(noticesOnly ? 'restart retains edited/deleted history and stable message IDs' : 'restart retains edited/deleted history, stable message IDs and native pin preference');
  if (!noticesOnly) {
  await page.locator('#pin-button').click(); await wait(value => !value.settings.chatAlwaysOnTop);
  await assertNativePin(false);
  }
  list = await messages(); await remove(list.at(-1));
  assert.equal(await page.getByRole('button', { name: '重新生成', exact: true }).count(), 0);
  await remove((await messages())[0]);
  assert.deepEqual(await messages(), []); await page.locator('#messages .empty').waitFor({ state: 'visible' });
  record(noticesOnly ? 'deleting all messages restores empty UI' : 'unpin restores normal window order; deleting all messages restores empty UI');
  const reportPath = noticesOnly ? 'docs/notice-order-validation.json' : `docs/chat-controls-${packaged ? 'packaged' : 'dev'}-validation.json`;
  await writeFile(reportPath, JSON.stringify({ passed: true, version, scope: noticesOnly ? 'notice-order-and-history-operations' : 'all-chat-controls',
    testedAt: new Date().toISOString(), realTavern: true, realProvider: false, pinChecked: !noticesOnly, checks }, null, 2) + '\n');
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
