import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access, rmdir } from 'node:fs/promises';
const packaged = process.argv.includes('--packaged'), version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = path.resolve('.test-data', `deletion-${packaged ? 'packaged-' : ''}${Date.now()}`); await mkdir(directory, { recursive: true });
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"mock-study"}]}'); return; }
  for await (const _chunk of req) { /* consume only isolated fixture requests */ }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '“中性模拟回复。”' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app, page, tavern; const checks = [];
const state = () => page.evaluate(() => window.friend.getState());
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
async function wait(predicate, timeout = 110000) { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate(await state())) return; await new Promise(r => setTimeout(r, 80)); } throw new Error('Deletion state timeout'); }
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}), args: packaged ? ['--integration-test'] : ['.', '--integration-test'], env: { ...process.env, FRIEND_TEST_DATA: directory, FRIEND_TEST_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend); page.on('dialog', dialog => dialog.accept());
  await wait(s => s.tavernReady || s.error); assert.ok((await state()).tavernReady, (await state()).error);
  tavern = app.windows().find(w => w.url().startsWith('http://127.0.0.1:'));
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, windowObservationEnabled: false }));
}
const getDoc = avatar => page.evaluate(avatar => window.friend.getCharacter(avatar), avatar);
const getWorld = name => tavern.evaluate(async name => { const ctx = SillyTavern.getContext(); const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name }) }); return r.json(); }, name);
const chatsPath = chat => path.join(directory, 'tavern-data/default-user/chats', chat.avatar.slice(0, -4), `${chat.fileName}.jsonl`);
try {
  await launch();
  const neutral = await page.evaluate(() => window.friend.saveCharacter({ fields: { name: '中性删除验证', description: '中性测试角色', personality: '', scenario: '', first_mes: '', mes_example: '' } }));
  await tavern.evaluate(async avatar => {
    const ctx = SillyTavern.getContext(), book = { name: `Neutral-book-${Date.now()}`, extensions: { keep_book: true }, entries: [
      { id: 1, name: '删除条目', keys: ['delete-fixture'], content: 'DELETE_LORE_FIXTURE', enabled: true, insertion_order: 1, extensions: { preserve_unknown: true } },
      { id: 2, name: '保留条目', keys: ['keep-fixture'], content: 'KEEP_LORE_FIXTURE', enabled: true, insertion_order: 2, extensions: {} },
    ] };
    const r = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar, data: { character_book: book, extensions: { deletion_unknown: { keep: true } } } }) }); assertResponse(r);
    function assertResponse(r) { if (!r.ok) throw new Error('Fixture write failed'); }
    await ctx.getCharacters();
  }, neutral.avatar);
  await page.evaluate(avatar => window.friend.selectCharacter(avatar), neutral.avatar);
  const source = await getDoc(neutral.avatar); assert.equal(source.lore.length, 2); assert.ok(source.linkedWorld);
  const originalWorld = await getWorld(source.linkedWorld), sourceBytes = await readFile(path.join(directory, 'tavern-data/default-user/characters', source.avatar));
  const copy = await page.evaluate(doc => window.friend.copyCharacter(doc.avatar, doc.revision), source);
  await page.locator('#settings-button').click(); await page.locator('#nav-characters').click(); await page.locator('#role-list').selectOption(copy.avatar);
  await page.waitForFunction(() => !document.getElementById('role-refresh').disabled); await page.locator('#role-lore').locator('summary').first().click();
  assert.equal(await page.locator('.lore-delete').count(), 2);
  await page.screenshot({ path: path.join(directory, 'lore-delete.png') });
  await page.getByRole('button', { name: '删除设定：删除条目', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('role-refresh').disabled);
  if (await page.locator('#role-error').isVisible()) throw new Error(await page.locator('#role-error').innerText());
  const edited = await getDoc(copy.avatar); assert.equal(edited.lore.length, 1); assert.equal(edited.lore[0].content, 'KEEP_LORE_FIXTURE'); assert.notEqual(edited.linkedWorld, source.linkedWorld);
  assert.deepEqual(await getWorld(source.linkedWorld), originalWorld); assert.ok((await readFile(path.join(directory, 'tavern-data/default-user/characters', source.avatar))).equals(sourceBytes));
  await assert.rejects(page.evaluate(doc => window.friend.deleteLore(doc.avatar, doc.loreRevision, 'e:0'), copy), /已变化/);
  await page.evaluate(avatar => window.friend.selectCharacter(avatar), copy.avatar);
  const emptied = await page.evaluate(doc => window.friend.deleteLore(doc.avatar, doc.loreRevision, doc.lore[0].key), edited);
  assert.equal(emptied.lore.length, 0); assert.equal(Object.keys((await getWorld(emptied.linkedWorld)).entries).length, 0);
  assert.equal((await state()).tavernReady, true);
  pass('per-entry lore delete persists to the card and a private world copy; original shared book/card stay intact; stale revisions are refused');
  await page.evaluate(() => window.friend.control('start', '删除验证任务'));
  const active = (await state()).archive;
  await assert.rejects(page.evaluate(id => window.friend.deleteRecord(id), active.activeTaskId), /结束当前/);
  await assert.rejects(page.evaluate(({ taskId, segmentId }) => window.friend.deleteRecord(taskId, segmentId), { taskId: active.activeTaskId, segmentId: active.activeSegmentId }), /正在使用/);
  await page.evaluate(() => window.friend.send('第一段测试')); await page.evaluate(() => window.friend.control('end'));
  await wait(s => !s.busy && !s.configuring); await page.evaluate(() => window.friend.control('start', '第二段测试'));
  await page.evaluate(() => window.friend.send('第二段测试')); await page.evaluate(() => window.friend.control('finish'));
  await page.locator('#nav-history').click();
  const tasks = await page.evaluate(() => window.friend.listTasks()), task = tasks.find(task => task.title === '删除验证任务'); assert.ok(task);
  const detail = await page.evaluate(id => window.friend.getTask(id), task.id); assert.equal(detail.segments.length, 2);
  await page.locator(`.task-entry[data-task-id="${task.id}"]`).click(); await page.locator('.segment-entry').nth(1).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(directory, 'history-delete.png') });
  const blocked = path.join(directory, 'chat-library.json.tmp'); await mkdir(blocked);
  await page.locator(`.segment-entry[data-segment-id="${detail.segments[0].id}"]`).locator('..').getByRole('button', { name: '删除这一段聊天记录', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('history-error').hidden && !document.querySelector('.segment-entry').disabled, null, { timeout: 15000 });
  await access(chatsPath(detail.segments[0].chat)); assert.equal((await page.evaluate(id => window.friend.getTask(id), task.id)).segments.length, 2); await rmdir(blocked);
  const liveFile = await tavern.evaluate(() => SillyTavern.getContext().chatId);
  await page.locator(`.segment-entry[data-segment-id="${detail.segments[0].id}"]`).locator('..').getByRole('button', { name: '删除这一段聊天记录', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.segment-entry').length === 1);
  assert.equal((await page.evaluate(id => window.friend.getTask(id), task.id)).segments[0].number, 2);
  await assert.rejects(access(chatsPath(detail.segments[0].chat)), { code: 'ENOENT' }); await access(chatsPath(detail.segments[1].chat));
  assert.equal(await tavern.evaluate(() => SillyTavern.getContext().chatId), liveFile);
  pass('segment delete uses Tavern persistence, preserves other segments/current chat, and an index-write failure restores the original chat');
  await page.locator(`.task-entry[data-task-id="${task.id}"]`).locator('..').getByRole('button', { name: '删除整次记录及其全部聊天段', exact: true }).click();
  await page.waitForFunction(id => !document.querySelector(`.task-entry[data-task-id="${id}"]`), task.id);
  await assert.rejects(access(chatsPath(detail.segments[1].chat)), { code: 'ENOENT' });
  await app.close(); app = undefined; await launch();
  assert.ok(!(await page.evaluate(() => window.friend.listTasks())).some(row => row.id === task.id)); assert.equal((await getDoc(copy.avatar)).lore.length, 0);
  pass('whole-task deletion removes remaining chat files, and restart preserves deleted history and lore state');
  await writeFile(path.join(directory, 'validation.json'), JSON.stringify({ passed: true, version, packaged, realTavern: true, realProvider: false, isolatedData: true, checks }, null, 2));
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
