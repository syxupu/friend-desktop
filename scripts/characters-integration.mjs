import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile, cp, symlink, unlink } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const withoutBundled = process.argv.includes('--without-bundled');
assert.ok(!(packaged && withoutBundled));
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = path.resolve('.test-data', `characters-${packaged ? 'packaged-' : ''}${Date.now()}`);
await mkdir(directory, { recursive: true });
let sourceRoot = '.';
if (withoutBundled) {
  sourceRoot = path.join(directory, 'no-bundled-app'); await mkdir(sourceRoot);
  await cp('dist', path.join(sourceRoot, 'dist'), { recursive: true });
  await cp('assets/pets', path.join(sourceRoot, 'assets/pets'), { recursive: true });
  await symlink(path.resolve('vendor'), path.join(sourceRoot, 'vendor'), 'junction');
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'friend-desktop', version, main: 'dist/main.js' }));
  // Suppress only bundled sample characters in this isolated test profile so
  // the first-run import is exercised with a genuinely empty Tavern library.
  const content = JSON.parse(await readFile('vendor/SillyTavern/default/content/index.json', 'utf8'));
  const userRoot = path.join(directory, 'tavern-data/default-user'); await mkdir(userRoot, { recursive: true });
  await writeFile(path.join(userRoot, 'content.log'), content.filter(item => item.type === 'character').map(item => item.filename).join('\n'));
}
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"mock-study"}]}'); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  requests.push(JSON.parse(text || '{}'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '“本机模拟回复。”' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const card = marker => ({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '中性测试角色', description: marker, personality: 'Test fixture.', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: 'Friend tests', character_version: '1', extensions: {} } });
const jsonPath = path.join(directory, 'role-a.json'), pngPath = path.join(directory, 'role-b.png'), invalidPath = path.join(directory, 'invalid.json');
await writeFile(jsonPath, JSON.stringify(card('FRIEND_ROLE_A_ONLY')));
await writeFile(invalidPath, '{}');
function textChunk(keyword, value) {
  const data = Buffer.from(`${keyword}\0${Buffer.from(JSON.stringify(value)).toString('base64')}`), chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4); return chunk;
}
const sprite = await readFile('assets/pets/wanxiang-fox/sprites/sit.png');
await writeFile(pngPath, Buffer.concat([sprite.subarray(0, -12), textChunk('chara', { ...card('SHOULD_NOT_APPEAR'), spec: 'chara_card_v2', spec_version: '2.0' }), textChunk('ccv3', card('FRIEND_ROLE_B_ONLY')), sprite.subarray(-12)]));
let app, page, launches = 0;
const checks = [], pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const state = () => page.evaluate(() => window.friend.getState());
async function wait(predicate, timeout = 110000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Character integration state timeout');
}
async function launch(missingSelection = false) {
  const needsImport = withoutBundled && launches++ === 0;
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}), args: packaged ? ['--integration-test'] : [sourceRoot, '--integration-test'],
    env: { ...process.env, FRIEND_TEST_DATA: directory, FRIEND_TEST_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend);
  await wait(s => s.tavernReady || s.error || s.connection.includes('请在陪伴设置中导入'));
  assert.equal((await state()).tavernReady, !(needsImport || missingSelection));
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, keepAwake: false }));
  await page.locator('#settings-button').click();
  await page.locator('#settings[open]').waitFor();
  await page.waitForFunction(() => !document.getElementById('refresh-characters').disabled);
}
async function importFile(file) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: !file, filePaths: file ? [file] : [] }); }, file);
  await page.locator('#import-character').click();
  await page.waitForFunction(() => !document.getElementById('import-character').disabled);
}
async function useSelected() {
  const target = await page.locator('#character-select').inputValue();
  await page.locator('#use-character').click();
  await page.waitForFunction(() => !document.getElementById('character-result').hidden && document.getElementById('character-result').textContent.startsWith('已切换到'));
  await wait(s => !s.configuring && s.characterAvatar === target);
}
try {
  await launch();
  const original = (await state()).characterAvatar;
  await importFile(null); assert.equal((await state()).characterAvatar, original);
  await importFile(invalidPath); assert.equal((await state()).characterAvatar, original);
  assert.ok(await page.locator('#character-result').evaluate(el => el.classList.contains('error')));
  pass('cancelled and invalid imports preserve the current character');
  await importFile(jsonPath);
  const roleA = await page.locator('#character-select').inputValue(); assert.notEqual(roleA, original);
  assert.equal((await state()).characterAvatar, original, 'import does not switch before confirmation');
  await useSelected(); assert.equal((await state()).characterAvatar, roleA);
  await page.evaluate(() => window.friend.send('A test question'));
  assert.ok(JSON.stringify(requests.at(-1)).includes('FRIEND_ROLE_A_ONLY'));
  const aMessages = (await state()).messages.filter(m => m.role !== 'notice'); assert.equal(aMessages.length, 2);
  pass('settings imports JSON and switches only on Use; real Tavern builds the selected role prompt');
  await importFile(pngPath);
  const roleB = await page.locator('#character-select').inputValue(); assert.notEqual(roleB, roleA);
  assert.equal(await page.locator('#character-select option').evaluateAll(items => items.filter(item => item.textContent.startsWith('中性测试角色')).length), 2);
  await useSelected(); assert.equal((await state()).characterAvatar, roleB);
  assert.equal((await state()).messages.filter(m => m.role !== 'notice').length, 0);
  await page.evaluate(() => window.friend.send('B test question'));
  const bPrompt = JSON.stringify(requests.at(-1)); assert.ok(bPrompt.includes('FRIEND_ROLE_B_ONLY')); assert.ok(!bPrompt.includes('FRIEND_ROLE_A_ONLY')); assert.ok(!bPrompt.includes('SHOULD_NOT_APPEAR'));
  pass('PNG V3 takes precedence; equal names get separate avatars and isolated conversation prompts');
  const tavern = app.windows().find(window => window.url().startsWith('http://127.0.0.1:'));
  await tavern.evaluate(async avatar => { const ctx = SillyTavern.getContext(); await ctx.selectCharacterById(ctx.characters.findIndex(c => c.avatar === avatar), { switchMenu: false }); }, roleA);
  await page.locator('#character-select').selectOption(roleB); await useSelected();
  assert.equal(await tavern.evaluate(() => { const ctx = SillyTavern.getContext(); return ctx.characters[ctx.characterId].avatar; }), roleB);
  pass('explicit selection resynchronizes a role changed through the advanced Tavern window');
  await page.locator('#character-select').selectOption(roleA); await useSelected();
  assert.deepEqual((await state()).messages.filter(m => m.role !== 'notice'), aMessages);
  const tasks = await page.evaluate(() => window.friend.listTasks());
  assert.ok(tasks.some(task => task.kind === 'free'));
  await page.evaluate(() => window.friend.control('start', 'Character guard test'));
  await assert.rejects(page.evaluate(avatar => window.friend.selectCharacter(avatar), roleB), /结束当前任务/);
  await page.evaluate(() => window.friend.control('finish'));
  await page.locator('#character-select').selectOption(roleB); await useSelected();
  pass('switching back restores messages and archives free chat; active tasks reject character changes');
  const beforeFailure = (await state()).messages.filter(m => m.role !== 'notice');
  await mkdir(path.join(directory, 'chat-library.json.tmp'));
  await assert.rejects(page.evaluate(avatar => window.friend.selectCharacter(avatar), roleA));
  assert.equal((await state()).characterAvatar, roleB);
  assert.deepEqual((await state()).messages.filter(m => m.role !== 'notice'), beforeFailure);
  const { rmdir } = await import('node:fs/promises'); await rmdir(path.join(directory, 'chat-library.json.tmp'));
  await page.evaluate(() => window.friend.action('retry-save'));
  pass('archive write failure keeps the original role and conversation');
  await app.close(); app = undefined; await launch();
  assert.equal((await state()).characterAvatar, roleB);
  assert.ok((await page.evaluate(() => window.friend.listCharacters())).some(c => c.avatar === roleA));
  pass('restart restores the selected imported role and preserves the existing Tavern library');
  await page.screenshot({ path: path.join(directory, 'character-settings.png') });
  await app.close(); app = undefined;
  await unlink(path.join(directory, 'tavern-data/default-user/characters', roleB));
  await launch(true);
  assert.ok((await state()).connection.includes('已选角色不存在'));
  await page.locator('#character-select').selectOption(roleA); await useSelected();
  assert.equal((await state()).characterAvatar, roleA);
  pass('deleted selected card offers explicit recovery through the existing-role selector');
  if (withoutBundled) pass('fresh app without a bundled card imports and selects its first character through settings');
  await writeFile(path.join(directory, 'validation.json'), JSON.stringify({ passed: true, version, packaged, withoutBundled, realTavern: true, realProvider: false, isolatedData: true, checks }, null, 2));
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
