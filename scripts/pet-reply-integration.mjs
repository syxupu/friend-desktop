import { _electron as electron } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const packaged = process.argv.includes('--packaged'), version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = path.resolve('.test-data', `pet-reply-${packaged ? 'packaged-' : ''}${Date.now()}`); await mkdir(directory, { recursive: true });
let serial = 0;
const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"mock-study"}]}'); return; }
  for await (const _chunk of req) { /* isolated fixture input only */ }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `“fixture-answer-${++serial}”` }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app, page, pet; const checks = [], pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const state = () => page.evaluate(() => window.friend.getState());
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`) } : {}), args: packaged ? ['--integration-test'] : ['.', '--integration-test'], env: { ...process.env, FRIEND_TEST_DATA: directory, FRIEND_TEST_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 120000 });
  page = await app.firstWindow(); await page.waitForFunction(() => window.friend);
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline) {
    const current = await state(); if (current.tavernReady || (current.error && !current.configuring)) break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  assert.ok((await state()).tavernReady, (await state()).error);
  pet = app.windows().find(window => window.url().endsWith('/pet.html')); await pet.waitForFunction(() => window.friend);
}
async function deleteUI(message) {
  await page.locator(`[data-message-id="${message.id}"] [data-action="delete"]`).click();
  await page.locator('#confirm-delete').click(); await page.locator('#message-delete').waitFor({ state: 'hidden' });
  await page.waitForFunction(id => !document.querySelector(`[data-message-id="${id}"]`), message.id);
}
try {
  await launch();
  const neutral = await page.evaluate(() => window.friend.saveCharacter({ fields: { name: '中性气泡删除验证', description: '中性测试', personality: '', scenario: '', first_mes: '', mes_example: '' } }));
  await page.evaluate(avatar => window.friend.selectCharacter(avatar), neutral.avatar);
  await page.evaluate(() => window.friend.saveSettings({ ttsEnabled: false, windowObservationEnabled: false }));
  const replies = [];
  for (let round = 1; round <= 5; round++) {
    await page.evaluate(round => window.friend.send(`fixture-question-${round}`), round);
    await pet.waitForFunction(round => document.getElementById('reply-text').textContent.includes(`fixture-answer-${round}`), round);
    replies.push((await state()).messages.findLast(message => message.role === 'assistant'));
  }
  await deleteUI(replies[1]);
  assert.equal(await pet.locator('#pet-reply').isVisible(), true); assert.equal(await pet.locator('#reply-text').innerText(), replies[4].text);
  pass('after 5 real Tavern rounds, deleting reply 2 keeps reply 5 displayed, never reply 1');
  await deleteUI(replies[4]); await pet.waitForFunction(() => document.getElementById('pet-reply').hidden);
  assert.equal(await pet.locator('#reply-text').textContent(), ''); assert.ok((await state()).messages.some(message => message.id === replies[3].id));
  await pet.locator('#fox').click(); assert.ok(await pet.locator('#pet-reply').isHidden());
  await deleteUI(replies[0]); assert.ok(await pet.locator('#pet-reply').isHidden());
  await page.evaluate(() => window.friend.saveSettings({})); assert.ok(await pet.locator('#pet-reply').isHidden());
  pass('deleting the latest reply clears the bubble; older history, fox clicks, older deletion and configuration refresh cannot revive it');
  const session = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')); assert.equal(session.petReplySuppressed, true); assert.ok(session.petReplyChat);
  await app.close(); app = undefined; await launch();
  assert.equal((await state()).petReplySuppressed, true); await pet.waitForFunction(() => document.getElementById('pet-reply').hidden);
  await pet.locator('#fox').click(); assert.ok(await pet.locator('#pet-reply').isHidden());
  await page.evaluate(() => window.friend.send('fixture-new-reply'));
  await pet.waitForFunction(() => document.getElementById('reply-text').textContent.includes('fixture-answer-6'));
  assert.equal((await state()).petReplySuppressed, false); assert.ok(await pet.locator('#pet-reply').isVisible());
  pass('restart preserves suppression for the same chat, and a new reply reopens the bubble normally');
  await writeFile(path.join(directory, 'validation.json'), JSON.stringify({ passed: true, version, packaged, realTavern: true, realProvider: false, isolatedData: true, checks }, null, 2));
} finally { if (app) await app.close(); server.closeAllConnections(); server.close(); }
