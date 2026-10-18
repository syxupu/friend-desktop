import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const packaged = process.argv.includes('--packaged'), version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = path.resolve('.test-data', `pet-api-${packaged ? 'packaged-' : ''}${Date.now()}`); await mkdir(directory, { recursive: true });
let modelRequests = 0, generationRequests = 0, lastModelKey = '', lastModel = '';
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    modelRequests++; lastModelKey = req.headers.authorization;
    if (req.url.includes('/fail/')) { res.writeHead(401); res.end('fictional-secret-provider-body'); return; }
    if (req.url.includes('/slow/')) await new Promise(r => setTimeout(r, 700));
    res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"mock-study"},{"id":"mock-second"}]}'); return;
  }
  let body = ''; for await (const chunk of req) body += chunk; const parsed = JSON.parse(body); lastModel = parsed.model; generationRequests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = text => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  chunk('“模拟流式');
  const timer = setTimeout(() => { chunk('回复完成。”'); res.end('data: [DONE]\n\n'); }, 1800);
  res.on('close', () => clearTimeout(timer));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let app, page, pet; const checks = [];
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const state = () => page.evaluate(() => window.friend.getState());
async function wait(predicate, timeout = 110000) { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate(await state())) return; await new Promise(r => setTimeout(r, 80)); } throw new Error('Pet/API state timeout'); }
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}), args: packaged ? ['--integration-test'] : ['.', '--integration-test'], env: { ...process.env, FRIEND_TEST_DATA: directory, FRIEND_TEST_URL: `${base}/v1` }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend); await wait(s => s.tavernReady || s.error);
  const initial = await state(); assert.ok(initial.tavernReady, initial.error || initial.connection);
  pet = app.windows().find(w => w.url().endsWith('/pet.html')); assert.ok(pet); await pet.waitForFunction(() => window.friend);
}
const geometry = () => app.evaluate(({ BrowserWindow, screen }) => { const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')); return { bounds: pet.getBounds(), work: screen.getDisplayMatching(pet.getBounds()).workArea }; });
try {
  await launch();
  const card = await page.evaluate(() => window.friend.saveCharacter({ fields: { name: '中性桌宠验证', description: '中性测试', personality: '', scenario: '', first_mes: '', mes_example: '' } }));
  await page.evaluate(avatar => window.friend.selectCharacter(avatar), card.avatar);
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, windowObservationEnabled: false }));
  assert.equal(await pet.locator('.toolbar, #badge, #pet-show-reply, #pet-chat, #pet-settings').count(), 0);
  assert.equal(await page.locator('#workspace-button').count(), 0); assert.equal(await page.locator('#back-to-chat').count(), 0);
  await page.locator('#settings-button').click(); assert.equal((await state()).view, 'dashboard');
  await page.locator('#settings-button').click(); assert.equal((await state()).view, 'chat');
  await pet.locator('#fox').click({ button: 'right' }); await wait(s => s.view === 'dashboard'); await page.locator('[name="deepseekUrl"]').waitFor({ state: 'visible' });
  pass('settings alone toggles compact/dashboard; pet toolbar is absent and right-click opens settings');
  await page.locator('[name="apiProvider"]').selectOption('custom'); await page.locator('[name="deepseekUrl"]').fill(`${base}/v1`);
  await page.locator('[name="deepseekKey"]').fill('fictional-model-query-key'); await page.locator('#fetch-models').click();
  await page.locator('#api-model-list').waitFor({ state: 'visible' }); assert.equal(lastModelKey, 'Bearer fictional-model-query-key');
  assert.equal((await state()).settings.hasDeepseekKey, true); assert.equal((await state()).settings.deepseekKey, '');
  await page.locator('#api-model-list').selectOption('mock-second'); assert.equal(await page.locator('[name="deepseekModel"]').inputValue(), 'mock-second');
  const before = await geometry();
  await page.locator('[name="petScale"]').fill('1.5'); await page.locator('#save-settings').click(); await wait(s => s.settings.petScale === 1.5 && !s.configuring);
  await pet.waitForFunction(() => document.getElementById('fox').getBoundingClientRect().height === 252);
  const after = await geometry();
  if (before.bounds.y + before.bounds.height - after.bounds.height >= after.work.y) assert.equal(after.bounds.y + after.bounds.height, before.bounds.y + before.bounds.height);
  else assert.equal(after.bounds.y, after.work.y);
  assert.ok(after.bounds.y >= after.work.y && after.bounds.y + after.bounds.height <= after.work.y + after.work.height);
  await page.locator('#fetch-models').click(); await page.waitForFunction(() => !document.getElementById('api-model-list').hidden); assert.equal(lastModelKey, 'Bearer fictional-model-query-key');
  pass('model list accepts transient and encrypted saved keys, selection persists, scaling keeps the pet on screen');
  const baselineRequests = modelRequests;
  await page.locator('[name="deepseekUrl"]').fill(`${base}/other/v1`); await page.locator('#fetch-models').click();
  await page.waitForFunction(() => document.getElementById('api-model-status').textContent.includes('密钥')); assert.equal(modelRequests, baselineRequests);
  await page.locator('[name="deepseekKey"]').fill('fictional-failure-key'); await page.locator('[name="deepseekUrl"]').fill(`${base}/fail/v1`);
  await page.locator('#fetch-models').click(); await page.waitForFunction(() => document.getElementById('api-model-status').textContent.includes('权限'));
  assert.ok(!(await page.locator('#api-model-status').innerText()).includes('fictional-secret'));
  await page.locator('[name="deepseekUrl"]').fill(`${base}/slow/v1`); await page.locator('#fetch-models').click();
  await page.locator('[name="apiProvider"]').selectOption('openai'); await page.waitForFunction(() => !document.getElementById('fetch-models').disabled);
  assert.equal(await page.locator('[name="deepseekModel"]').inputValue(), ''); assert.ok(await page.locator('#api-model-list').isHidden());
  pass('changed endpoints cannot reuse saved keys; authentication errors are redacted and stale model lists are ignored');
  const fixedWidth = Math.round((await state()).settings.petScale * 324);
  await app.evaluate(({ BrowserWindow }, width) => { const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')); window.setBounds({ width: width + 180 }); }, fixedWidth);
  await pet.waitForFunction(width => innerWidth === width, fixedWidth);
  let position = await geometry();
  for (const x of [position.work.x, position.work.x + position.work.width - fixedWidth, position.work.x + (position.work.width - fixedWidth) / 2]) {
    await pet.evaluate(({ x, y }) => window.friend.movePet(x, y), { x, y: position.work.y + 35 });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await geometry()).bounds.width, fixedWidth);
    assert.equal(await pet.locator('#pet-form').evaluate(element => element.getBoundingClientRect().width), fixedWidth - 20);
  }
  const beforeDrag = (await geometry()).bounds;
  const foxBounds = await pet.locator('#fox').boundingBox();
  await pet.mouse.move(foxBounds.x + foxBounds.width / 2, foxBounds.y + foxBounds.height / 2); await pet.mouse.down();
  await pet.mouse.move(foxBounds.x + foxBounds.width / 2 + 35, foxBounds.y + foxBounds.height / 2 + 15, { steps: 4 }); await pet.mouse.up();
  assert.equal((await geometry()).bounds.width, fixedWidth);
  const afterDrag = (await geometry()).bounds;
  assert.ok(afterDrag.x !== beforeDrag.x || afterDrag.y !== beforeDrag.y);
  assert.ok(!await pet.locator('#fox').evaluate(element => element.classList.contains('dragging')));
  pass('native width repairs unexpected resizing and stays fixed at both screen edges and after mouse dragging');
  await page.evaluate(() => window.friend.action('hide'));
  await pet.locator('#pet-input').fill('中性测试：桌宠直接输入'); await pet.locator('#pet-send').click();
  await pet.waitForFunction(() => document.getElementById('reply-text').textContent.includes('模拟流式'));
  assert.equal((await state()).busy, true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible()), false);
  await wait(s => !s.busy); assert.ok((await pet.locator('#reply-text').innerText()).includes('回复完成')); assert.equal(lastModel, 'mock-second');
  const expanded = await geometry(); await pet.locator('#pet-close-reply').click();
  await pet.waitForFunction(() => document.getElementById('pet-reply').hidden); await new Promise(r => setTimeout(r, 120));
  assert.ok((await geometry()).bounds.height < expanded.bounds.height);
  const count = generationRequests; await pet.locator('#pet-input').fill('中性测试：取消'); await pet.locator('#pet-input').press('Enter');
  await pet.waitForFunction(() => document.getElementById('reply-text').textContent.includes('模拟流式'));
  await pet.locator('#pet-stop').click(); await wait(s => !s.busy); assert.equal(generationRequests, count + 1);
  await new Promise(r => setTimeout(r, 1900)); assert.ok(!(await pet.locator('#reply-text').innerText()).includes('回复完成'));
  await pet.locator('#pet-input').fill('下一条草稿'); assert.equal(await pet.locator('#pet-input').inputValue(), '下一条草稿');
  pass('pet input streams replies while chat stays hidden; closing shrinks the bubble and cancellation fences late text');
  await pet.screenshot({ path: path.join(directory, 'pet-overlay.png') });
  await pet.locator('#fox').click({ button: 'right' }); await page.locator('#nav-settings').click(); await page.screenshot({ path: path.join(directory, 'api-settings.png') });
  await app.close(); app = undefined; await launch(); assert.equal((await state()).settings.petScale, 1.5); assert.equal((await state()).settings.deepseekKey, '');
  // Integration mode substitutes only the dialogue API on launch; scale remains genuine persisted data.
  pass('restart restores pet scale without exposing stored keys');
  await writeFile(path.join(directory, 'validation.json'), JSON.stringify({ passed: true, version, packaged, realTavern: true, realProvider: false, isolatedData: true, checks }, null, 2));
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
