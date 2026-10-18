import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, rmdir } from 'node:fs/promises';
const packaged = process.argv.includes('--packaged'), version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = path.resolve('.test-data', `workshop-${packaged ? 'packaged-' : ''}${Date.now()}`); await mkdir(directory, { recursive: true });
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"mock-study"}]}'); return; }
  let text = ''; for await (const chunk of req) text += chunk; requests.push(JSON.parse(text || '{}'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '“本机模拟陪伴回复。”' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app, page, tavern;
const checks = [], pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const state = () => page.evaluate(() => window.friend.getState());
async function wait(predicate, timeout = 110000) { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate(await state())) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Workshop state timeout'); }
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}), args: packaged ? ['--integration-test'] : ['.', '--integration-test'], env: { ...process.env, FRIEND_TEST_DATA: directory, FRIEND_TEST_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend); await wait(s => s.tavernReady || s.error); assert.ok((await state()).tavernReady);
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, keepAwake: false }));
  tavern = app.windows().find(w => w.url().startsWith('http://127.0.0.1:'));
  await page.evaluate(() => window.friend.action('dashboard')); await page.locator('#nav-characters').click();
  await page.waitForFunction(() => !document.getElementById('role-refresh').disabled);
}
async function clickAndStatus(id, pattern) {
  await page.locator(id).click();
  await page.waitForFunction(() => !document.getElementById('role-refresh').disabled);
  if (!(await page.locator('#role-error').isHidden())) throw new Error(await page.locator('#role-error').innerText());
  assert.ok((await page.locator('#role-status').innerText()).includes(pattern)); await wait(s => !s.configuring);
}
const getDoc = avatar => page.evaluate(avatar => window.friend.getCharacter(avatar), avatar);
const getRaw = avatar => tavern.evaluate(async avatar => { const ctx = SillyTavern.getContext(); const all = await fetch('/api/characters/all', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' }).then(r => r.json()); return all.find(c => c.avatar === avatar).data; }, avatar);
async function choose(avatar) { await page.locator('#role-list').selectOption(avatar); await page.waitForFunction(() => !document.getElementById('role-refresh').disabled); }
try {
  await launch();
  await page.locator('#role-new').click();
  await page.locator('#role-name').fill('中性桌宠测试'); await page.locator('#role-description').fill('WORKSHOP_PERSONA_KEEP');
  await page.locator('#role-personality').fill('温和简洁，使用引号说话。'); await page.locator('#role-scenario').fill('与用户一起学习的朋友。');
  await page.locator('#role-greeting').fill('<p>“WORKSHOP_GREETING”</p><script>globalThis.__badPreview = true</script>');
  await page.locator('#role-preview-button').click(); assert.equal(await page.locator('#role-preview').innerText(), '“WORKSHOP_GREETING”');
  assert.equal(await page.evaluate(() => globalThis.__badPreview), undefined);
  await page.locator('#role-adopt-preview').click(); assert.equal(await page.locator('#role-greeting').inputValue(), '“WORKSHOP_GREETING”');
  await clickAndStatus('#role-save', '角色卡已保存');
  const original = await page.locator('#role-list').inputValue(); assert.ok(original.endsWith('.png'));
  // Add advanced data through the genuine Tavern backend, then test that quick
  // edits and duplicates preserve it. Never depend on a user's private card.
  await tavern.evaluate(async avatar => {
    const ctx = SillyTavern.getContext();
    const fields = { data: { extensions: { workshop_unknown: { keep: 'UNKNOWN_KEEP' } }, character_book: { name: 'Neutral lore', entries: [{ id: 0, keys: ['workshop-lore'], content: 'LORE_CONTENT_KEEP', extensions: {}, enabled: true, insertion_order: 100, case_sensitive: false, name: '背景设定', priority: 10, constant: false, selective: false, secondary_keys: [], position: 'before_char' }] } } };
    const r = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar, ...fields }) }); if (!r.ok) throw new Error('Fixture setup failed'); await ctx.getCharacters();
  }, original);
  await clickAndStatus('#role-refresh', '已重新读取');
  assert.equal((await getDoc(original)).lore.length, 1);
  pass('quick create saves a native Tavern card; opening preview strips markup without executing it');
  const originalBefore = await readFile(path.join(directory, 'tavern-data/default-user/characters', original));
  await clickAndStatus('#role-copy', '桌宠版副本已创建');
  const copy = await page.locator('#role-list').inputValue(); assert.notEqual(copy, original);
  assert.ok((await readFile(path.join(directory, 'tavern-data/default-user/characters', original))).equals(originalBefore));
  await page.locator('#role-name').fill('中性桌宠测试·调整版'); await page.locator('#role-description').fill('WORKSHOP_PERSONA_EDITED');
  await page.locator('#role-greeting').fill('“WORKSHOP_NEW_GREETING”');
  await page.locator('details').filter({ has: page.locator('#role-examples') }).locator('summary').click();
  await page.locator('#role-examples').fill('<START>\n{{user}}: 你好\n{{char}}: “你好。”');
  await clickAndStatus('#role-save', '角色卡已保存');
  const raw = await getRaw(copy); assert.equal(raw.extensions.workshop_unknown.keep, 'UNKNOWN_KEEP'); assert.equal(raw.character_book.entries[0].content, 'LORE_CONTENT_KEEP');
  assert.ok((await readdir(path.join(directory, 'character-backups'))).length > 0);
  pass('duplicate preserves the original PNG; editing keeps artwork, unknown extensions, lore and stable avatar identity');
  await page.locator('#companion-form select[name="length"]').selectOption('brief'); await page.locator('#companion-form select[name="actions"]').selectOption('none');
  await page.locator('#companion-form input[name="noFollowUp"]').check();
  await page.locator('#companion-form textarea[name="studyStyle"]').fill('WORKSHOP_STUDY_STYLE'); await page.locator('#companion-form textarea[name="breakStyle"]').fill('WORKSHOP_BREAK_STYLE');
  const cardBeforePreferences = await readFile(path.join(directory, 'tavern-data/default-user/characters', copy));
  await page.locator('#role-description').fill('UNSAVED_ROLE_DRAFT');
  await clickAndStatus('#companion-save', '陪伴偏好已保存');
  assert.equal(await page.locator('#role-description').inputValue(), 'UNSAVED_ROLE_DRAFT');
  await page.locator('#role-description').fill('WORKSHOP_PERSONA_EDITED');
  assert.ok((await readFile(path.join(directory, 'tavern-data/default-user/characters', copy))).equals(cardBeforePreferences));
  await clickAndStatus('#role-use', '正在使用');
  assert.equal((await state()).messages.filter(m => m.role !== 'notice').length, 0);
  const beforeStart = requests.length;
  await page.evaluate(() => window.friend.send('workshop test')); const idlePrompt = JSON.stringify(requests.at(-1)); assert.ok(idlePrompt.includes('回复简短')); assert.ok(!idlePrompt.includes('WORKSHOP_STUDY_STYLE')); assert.ok(!idlePrompt.includes('WORKSHOP_NEW_GREETING'));
  await page.evaluate(() => window.friend.control('start', 'Neutral study'));
  await page.evaluate(() => window.friend.control('pause')); await page.evaluate(() => window.friend.control('resume'));
  assert.equal(requests.length, beforeStart + 1);
  await page.evaluate(() => window.friend.send('workshop study test')); const studyPrompt = JSON.stringify(requests.at(-1)); assert.ok(studyPrompt.includes('WORKSHOP_STUDY_STYLE')); assert.ok(!studyPrompt.includes('WORKSHOP_BREAK_STYLE'));
  const draft = await getDoc(copy); await assert.rejects(page.evaluate(doc => window.friend.saveCharacter({ avatar: doc.avatar, revision: doc.revision, fields: doc.fields }), draft), /结束当前学习任务/);
  await page.evaluate(() => window.friend.control('end')); await wait(s => !s.busy && !s.configuring);
  assert.ok(JSON.stringify(requests.at(-1)).includes('WORKSHOP_BREAK_STYLE'));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('WORKSHOP_NEW_GREETING'));
  const afterBreak = requests.length; await page.evaluate(() => window.friend.control('end')); assert.equal(requests.length, afterBreak);
  await page.evaluate(() => window.friend.control('finish'));
  pass('preferences stay outside the card and enter real Tavern prompts according to authoritative study/break state');
  await clickAndStatus('#role-new-chat', '旧聊天已归档');
  assert.equal((await state()).messages.filter(m => m.role !== 'notice').length, 0);
  assert.equal((await getRaw(copy)).first_mes, '“WORKSHOP_NEW_GREETING”');
  const greetingBackup = await tavern.evaluate(() => SillyTavern.getContext().chatMetadata.friend_greeting_backup?.message.mes);
  assert.equal(greetingBackup, '“WORKSHOP_NEW_GREETING”');
  // Reopen the native header-only chat: Tavern recreates a greeting, which the
  // desktop bridge must remove and persist again before exposing the history.
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false }));
  assert.equal((await state()).messages.filter(m => m.role !== 'notice').length, 0);
  await page.evaluate(() => window.friend.send('fresh desktop chat'));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('WORKSHOP_NEW_GREETING'));
  const nativeChat = await tavern.evaluate(() => SillyTavern.getContext().chat.map(m => m.mes));
  assert.deepEqual(nativeChat, ['fresh desktop chat', '“本机模拟陪伴回复。”']);
  await page.locator('#role-greeting').fill(''); await clickAndStatus('#role-save', '角色卡已保存');
  await clickAndStatus('#role-new-chat', '旧聊天已归档'); assert.equal((await state()).messages.filter(m => m.role !== 'notice').length, 0);
  await page.locator('#role-greeting').fill('“WORKSHOP_NEW_GREETING”'); await clickAndStatus('#role-save', '角色卡已保存');
  await clickAndStatus('#role-new-chat', '旧聊天已归档');
  assert.ok((await page.evaluate(() => window.friend.listTasks())).length > 0);
  pass('desktop chats ignore saved greetings in the UI, native history and model prompts; card fields and archived conversations are preserved');
  const beforeEmptyBreak = requests.length;
  await page.evaluate(() => window.friend.control('start', 'Empty segment'));
  await page.evaluate(() => window.friend.control('end')); await wait(s => !s.busy && !s.configuring);
  assert.equal(requests.length, beforeEmptyBreak + 1);
  assert.ok(JSON.stringify(requests.at(-1)).includes('WORKSHOP_BREAK_STYLE'));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('WORKSHOP_NEW_GREETING'));
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false }));
  assert.deepEqual(await tavern.evaluate(() => SillyTavern.getContext().chat.map(m => m.mes)), ['“本机模拟陪伴回复。”']);
  await page.evaluate(() => window.friend.control('end')); assert.equal(requests.length, beforeEmptyBreak + 1);
  await page.evaluate(() => window.friend.control('finish'));
  pass('an empty study segment triggers one real generated break reply; refreshing and duplicate end preserve it without loading a card greeting');
  const stale = await getDoc(copy);
  await tavern.evaluate(async avatar => { const ctx = SillyTavern.getContext(); await fetch('/api/characters/merge-attributes', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar, description: 'ADVANCED_EDIT', data: { description: 'ADVANCED_EDIT' } }) }); await ctx.getCharacters(); }, copy);
  await assert.rejects(page.evaluate(doc => window.friend.saveCharacter({ avatar: doc.avatar, revision: doc.revision, fields: doc.fields }), stale), /已变化/);
  const beforeFailure = await getDoc(copy); await mkdir(path.join(directory, 'companions.json.tmp'));
  await assert.rejects(page.evaluate(doc => window.friend.saveCompanionPreferences(doc.avatar, doc.preferenceRevision, { ...doc.preferences, length: 'detailed' }), beforeFailure));
  assert.deepEqual((await getDoc(copy)).preferences, beforeFailure.preferences); await rmdir(path.join(directory, 'companions.json.tmp'));
  pass('stale editor revisions are refused; preference write failure retains the previous saved values');
  await clickAndStatus('#role-refresh', '已重新读取'); await clickAndStatus('#role-advanced', '已打开此角色');
  await page.locator('.role-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(directory, 'role-workshop.png') });
  await app.close(); app = undefined; await launch();
  assert.equal((await state()).characterAvatar, copy); const restored = await getDoc(copy); assert.equal(restored.preferences.length, 'brief'); assert.equal(restored.fields.description, 'ADVANCED_EDIT');
  assert.equal(restored.fields.first_mes, '“WORKSHOP_NEW_GREETING”');
  assert.equal((await state()).messages.filter(m => m.role !== 'notice').length, 0);
  assert.equal(await tavern.evaluate(() => SillyTavern.getContext().chat.length), 0);
  await page.evaluate(() => window.friend.send('after restart'));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('WORKSHOP_NEW_GREETING'));
  assert.equal((await getDoc(original)).fields.description, 'WORKSHOP_PERSONA_KEEP');
  pass('advanced editor opens the selected role; restart restores the edited card and independent preferences');
  await writeFile(path.join(directory, 'validation.json'), JSON.stringify({ passed: true, version, packaged, realTavern: true, realProvider: false, isolatedData: true, checks }, null, 2));
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
