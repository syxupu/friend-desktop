import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { mkdir, rmdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const packaged = process.argv.includes('--packaged');
const directory = path.resolve('.test-data', `archive-${packaged ? 'packaged-' : ''}${Date.now()}`);
let serial = 0, slow = false;
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"mock-study"}]}'); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  JSON.parse(text || '{}'); const delay = slow ? 220 : 20; slow = false;
  const reply = `“本机测试回复${++serial}，先完成这一小步，我陪着你。”`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (let i = 0; i < reply.length && !res.destroyed; i += 4) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.slice(i, i + 4) }, finish_reason: null }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  if (!res.destroyed) res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app, page, tavern;
const checks = [], record = label => { checks.push(label); console.log(`PASS ${label}`); };
const state = () => page.evaluate(() => window.friend.getState());
const messages = async () => (await state()).messages.filter(message => message.role !== 'notice');
const tasks = () => page.evaluate(() => window.friend.listTasks());
async function wait(predicate, timeout = 100000) {
  const deadline = Date.now() + timeout;
  do { const value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 75)); } while (Date.now() < deadline);
  const value = await state(); throw new Error(`State wait expired: ${value.connection}; ${value.error}; mode=${value.study.mode}`);
}
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}),
    args: packaged ? ['--integration-test'] : ['.', '--integration-test'], env: { ...process.env, FRIEND_TEST_DATA: directory,
      FRIEND_TEST_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend, null, { timeout: 30000 });
  await wait(value => value.tavernReady || value.error); assert.equal((await state()).tavernReady, true, (await state()).error);
  tavern = app.windows().find(window => window.url().startsWith('http://127.0.0.1:'));
  assert.ok(tavern); await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, keepAwake: false }));
}
async function segment(taskId, id) { return page.evaluate(({ taskId, id }) => window.friend.getSegment(taskId, id), { taskId, id }); }
try {
  await launch(); assert.deepEqual(await tasks(), []);
  const compact = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')).getSize());
  await page.locator('#settings-button').click(); await wait(value => value.view === 'dashboard');
  const expanded = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html')).getSize());
  assert.ok(expanded[0] > compact[0]); await page.locator('#nav-settings').click();
  await page.locator('#settings[open]').waitFor({ state: 'visible' });
  await page.locator('input[name="userName"]').fill('验收用户'); await page.locator('#save-settings').click();
  await page.locator('#settings-saved').waitFor({ state: 'visible' }); assert.equal((await state()).settings.userName, '验收用户');
  assert.equal((await page.locator('input[name="deepseekKey"]').inputValue()), '');
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: `docs/screenshots/archive-settings-${packaged ? 'packaged' : 'dev'}.png` });
  await page.locator('#settings-button').click(); await wait(value => value.view === 'chat');
  record('native compact/dashboard switch and large settings form preserve API secret masking');
  await page.evaluate(() => window.friend.control('start', '数学任务·第一段'));
  await page.evaluate(() => window.friend.send('第一段的学习问题'));
  const firstTaskId = (await tasks())[0].id;
  let task = await page.evaluate(id => window.friend.getTask(id), firstTaskId);
  assert.equal(task.segments.length, 1); assert.equal((await messages()).length, 2);
  const user = (await messages())[0];
  await page.evaluate(message => window.friend.changeMessage({ action: 'edit', id: message.id, expectedText: message.text, text: '第一段修改后的问题' }), user);
  assert.equal((await segment(firstTaskId, task.segments[0].id)).messages[0].text, '第一段修改后的问题');
  await page.locator('#end').click(); await wait(value => value.study.mode === 'break' && !value.configuring && !value.busy);
  assert.ok((await messages()).every(message => !message.text.includes('第一段修改后的问题')));
  await page.evaluate(() => window.friend.send('第一段之后的休息聊天'));
  const firstHistory = await segment(firstTaskId, task.segments[0].id);
  assert.ok(firstHistory.messages.some(message => message.text.includes('第一段修改后的问题')));
  assert.ok(firstHistory.messages.some(message => message.text.includes('第一段之后的休息聊天')));
  assert.ok(firstHistory.messages.length >= 5);
  record('end segment hides completed learning, archives its edited messages, and attaches break conversation');
  await page.evaluate(() => window.friend.control('start', '数学任务·第二段'));
  assert.deepEqual(await messages(), []); await page.evaluate(() => window.friend.send('第二段的学习问题'));
  assert.equal((await tasks()).filter(task => task.kind === 'study').length, 1);
  task = await page.evaluate(id => window.friend.getTask(id), firstTaskId); assert.equal(task.segments.length, 2);
  assert.notEqual(task.segments[0].chat.fileName, task.segments[1].chat.fileName);
  await page.locator('#finish').click(); await wait(value => value.study.mode === 'idle' && !value.configuring);
  assert.equal((await state()).study.elapsedMs, 0); assert.equal(await page.locator('#timer').textContent(), '00:00:00');
  assert.deepEqual(await messages(), []); assert.ok((await tasks())[0].endedAt);
  record('two independent segment files belong to one task; finish resets timer and clears chat without deleting history');
  const currentFile = await tavern.evaluate(() => window.SillyTavern.getContext().chatId);
  await page.locator('#settings-button').click(); await wait(value => value.view === 'dashboard'); await page.locator('#nav-history').click();
  await page.locator(`.task-entry[data-task-id="${firstTaskId}"]`).click();
  await page.locator('.segment-entry').nth(1).waitFor({ state: 'visible' });
  await page.locator('.segment-entry').first().click();
  await page.getByText('第一段修改后的问题', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('#record-search').fill('休息聊天');
  assert.equal(await page.locator('#record-messages .message').count(), 1);
  await page.locator('.segment-entry').nth(1).click();
  await page.getByText('第二段的学习问题', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await tavern.evaluate(() => window.SillyTavern.getContext().chatId), currentFile);
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: `docs/screenshots/archive-${packaged ? 'packaged' : 'dev'}.png` });
  record('dashboard drills down task/segment/messages, searches text and never switches the live Tavern chat');
  await page.locator('#settings-button').click(); await wait(value => value.view === 'chat');
  await page.evaluate(() => window.friend.control('start', '第二次任务'));
  await page.evaluate(() => window.friend.send('保存失败时必须保留的聊天'));
  // Deliberately fail only this isolated profile's metadata temp file.
  const blocker = path.join(directory, 'chat-library.json.tmp'); await mkdir(blocker);
  const failed = await page.evaluate(async () => { try { await window.friend.control('end'); return false; } catch { return true; } });
  assert.equal(failed, true); assert.equal((await state()).study.mode, 'paused');
  assert.ok((await messages()).some(message => message.text.includes('保存失败时必须保留的聊天')));
  await rmdir(blocker);
  await page.evaluate(() => window.friend.control('end')); await wait(value => !value.busy && !value.configuring);
  assert.equal((await state()).study.mode, 'break');
  record('archive disk failure pauses safely without clearing chat; retry succeeds');
  const secondTask = (await tasks()).find(task => !task.endedAt);
  assert.ok(secondTask); const breakMessages = await messages();
  await app.close(); app = null; await launch();
  assert.equal((await state()).study.mode, 'break'); assert.deepEqual(await messages(), breakMessages);
  assert.ok(!(await messages()).some(message => message.text.includes('保存失败时必须保留的聊天')));
  assert.equal((await tasks()).length, 2);
  record('restart restores task grouping and break view without reloading hidden learning messages');
  await page.evaluate(() => window.friend.control('start', '第二次任务·新段'));
  slow = true;
  const generating = page.evaluate(() => window.friend.send('结束时仍在生成的问题'));
  await wait(value => value.busy && value.messages.some(message => message.pending && message.text.length > 0));
  await page.evaluate(() => window.friend.control('finish')); await generating;
  await wait(value => !value.busy && !value.configuring);
  assert.equal((await state()).study.mode, 'idle'); assert.equal((await state()).study.elapsedMs, 0); assert.deepEqual(await messages(), []);
  const task2 = await page.evaluate(id => window.friend.getTask(id), secondTask.id);
  assert.equal(task2.segments.length, 2);
  const interrupted = await segment(secondTask.id, task2.segments[1].id);
  assert.ok(interrupted.messages.some(message => message.text.includes('结束时仍在生成的问题')));
  record('finish during streaming cancels the producer, saves the segment and prevents stale text returning to the cleared UI');
  const refused = await page.evaluate(async () => { try { await window.friend.getTask('../../outside'); return false; } catch { return true; } });
  assert.equal(refused, true);
  await writeFile(`docs/archive-${packaged ? 'packaged' : 'dev'}-validation.json`, JSON.stringify({ passed: true, version, testedAt: new Date().toISOString(),
    realTavern: true, realProvider: false, isolatedData: true, checks }, null, 2) + '\n');
} catch (cause) {
  if (page) { const value = await state().catch(() => null); if (value) console.error(JSON.stringify({ mode: value.study.mode, busy: value.busy, configuring: value.configuring, error: value.error, connection: value.connection })); }
  throw cause;
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
