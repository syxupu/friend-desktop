import http from 'node:http';
import { readFile, mkdir, writeFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright';
import { focusTestProcess } from './test-window-focus.mjs';

const requests = [], speechRequests = [];
let abortedStreams = 0;
const reply = '*她把试卷摆正，指向第一道题。* “先从熟悉的题目开始，我陪着你。”';
const titleA = '窗口读取验收 A：高数“导数” 📚';
const titleB = '窗口读取验收 B：第二节·微分';
function wav() {
  const data = Buffer.alloc(44 + 24_000 * 2 * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data.toString('base64');
}
const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && ['/window-fixture-a', '/window-fixture-b'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>${req.url.endsWith('-a') ? titleA : titleB}</title><h1>Friend 本机窗口读取验收</h1><p>独立 Edge 测试页面，不访问 B 站或个人浏览记录。</p>`); return;
  }
  if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-study' }] })); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  let content = ''; for await (const chunk of req) content += chunk;
  const body = JSON.parse(content);
  if (body.audio) {
    speechRequests.push(body);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { audio: { data: wav() } } }] })); return;
  }
  requests.push(body);
  const slow = String(body.messages.findLast(m => m.role === 'user')?.content).includes('P1慢速');
  if (String(body.messages.findLast(m => m.role === 'user')?.content).includes('模拟服务错误')) { res.writeHead(429).end(JSON.stringify({ error: { message: 'simulated rate limit' } })); return; }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.on('close', () => { if (!res.writableEnded) abortedStreams++; });
    for (let i = 0; i < reply.length; i += 6) {
      if (res.destroyed) break;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.slice(i, i + 6) }, finish_reason: null }] })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, slow ? 200 : 45));
    }
    res.end('data: [DONE]\n\n');
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] })); }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
let app, browser;
async function waitState(page, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.friend.getState());
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const last = await page.evaluate(() => window.friend.getState());
  throw new Error(`App state wait timed out (window status=${last.foreground?.status}, process=${last.foreground?.current?.processName}, own=${last.foreground?.current?.isOwnApp})`);
}
async function focusAndWait(page, processId, predicate) {
  let lastFocus = 0;
  let focusError = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.friend.getState());
    if (snapshot.foreground.current?.processId === processId && predicate(snapshot)) return snapshot;
    if (Date.now() - lastFocus > 1000) { try { focusTestProcess(processId); } catch (e) { focusError = e.message; } lastFocus = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`The test-owned foreground window was not observed (${processId}; ${focusError})`);
}
try {
  const packaged = process.env.FRIEND_TEST_PACKAGED === '1';
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const packagedExe = process.env.FRIEND_TEST_EXE || path.resolve(`release/${version}/win-unpacked/Friend 桌宠.exe`);
  const dataDirectory = path.resolve('.test-data', `${packaged ? 'packaged' : 'run'}-${Date.now()}`);
  app = await electron.launch({ ...(packaged ? { executablePath: packagedExe } : {}), args: packaged ? ['--integration-test'] : ['.', '--integration-test'], env: { ...process.env, FRIEND_TEST_URL: mockUrl, FRIEND_TEST_DATA: dataDirectory }, timeout: 120_000 });
  app.process().stderr.on('data', data => process.stderr.write(data));
  const chat = await app.firstWindow();
  await chat.waitForFunction(() => window.friend, null, { timeout: 30_000 });
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const snapshot = await chat.evaluate(() => window.friend.getState());
    if (snapshot.tavernReady || snapshot.error) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  let state = await chat.evaluate(() => window.friend.getState());
  assert.equal(state.tavernReady, true, state.error ?? state.connection);
  assert.equal(state.bookEntries, 8);
  assert.equal(state.foreground.status, 'inactive', 'no observation before studying');
  const secrets = await chat.evaluate(() => window.friend.getState());
  assert.equal(secrets.settings.deepseekKey, ''); assert.equal(secrets.settings.mimoKey, '');
  const windows = app.windows(); const pet = windows.find(w => w.url().endsWith('pet.html'));
  assert.ok(pet, 'pet window exists');
  const petProperties = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('pet.html')); return { top: w.isAlwaysOnTop(), frame: w.isResizable(), visible: w.isVisible() }; });
  assert.deepEqual(petProperties, { top: true, frame: false, visible: true });
  await chat.evaluate(() => window.friend.control('start', '高等数学：导数'));
  await chat.waitForTimeout(1100);
  state = await chat.evaluate(() => window.friend.getState()); assert.equal(state.study.mode, 'study'); assert.ok(state.study.elapsedMs >= 1000);
  // Keep app controls out of the way while the real browser is foreground.
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().startsWith('file:')) w.hide(); });
  browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--no-first-run', '--no-default-browser-check'] });
  const browserSession = await browser.newBrowserCDPSession();
  const browserProcesses = await browserSession.send('SystemInfo.getProcessInfo');
  const edgeProcessId = browserProcesses.processInfo.find(p => p.type === 'browser').id;
  const edge = await browser.newPage();
  await edge.goto(`${mockUrl.replace('/v1', '')}/window-fixture-a`); await edge.bringToFront();
  const firstObservation = await focusAndWait(chat, edgeProcessId, s => s.foreground.current.processName?.toLowerCase() === 'msedge.exe' && s.foreground.current.title.includes(titleA));
  assert.ok(firstObservation.foreground.current.executablePath.toLowerCase().endsWith('msedge.exe'));
  await edge.goto(`${mockUrl.replace('/v1', '')}/window-fixture-b`);
  assert.equal(await edge.title(), titleB);
  const changedObservation = await focusAndWait(chat, edgeProcessId, s => s.foreground.current.title.includes(titleB));
  assert.ok(changedObservation.foreground.lastExternal.title.includes(titleB));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).showInactive());
  const mainProcessId = await app.evaluate(() => process.pid);
  await focusAndWait(chat, mainProcessId, s => s.foreground.current.isOwnApp && s.foreground.lastExternal?.title.includes(titleB));
  await chat.locator('#window-observation').evaluate(element => element.open = true);
  assert.ok((await chat.locator('#window-title').innerText()).includes(titleB));
  assert.ok((await chat.locator('#window-context').innerText()).includes('最近'));
  await mkdir('docs/screenshots', { recursive: true });
  await chat.screenshot({ path: 'docs/screenshots/window-observation.png' });
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  assert.equal((await chat.evaluate(() => window.friend.getState())).foreground.status, 'locked');
  assert.equal((await chat.evaluate(() => window.friend.getState())).foreground.lastExternal, null);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  await waitState(chat, s => s.foreground.status === 'active');
  await chat.evaluate(() => window.friend.saveSettings({ windowObservationEnabled: false }));
  assert.equal((await chat.evaluate(() => window.friend.getState())).foreground.status, 'disabled');
  await chat.evaluate(() => window.friend.saveSettings({ windowObservationEnabled: true }));
  await waitState(chat, s => s.foreground.status === 'active');
  await browser.close(); browser = null;
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().startsWith('file:')) w.show(); });
  await chat.locator('#window-observation').evaluate(element => element.open = false);
  const sending = chat.evaluate(() => window.friend.send('我在复习导数，陪我做一道题吧。'));
  await waitState(chat, s => s.messages.some(m => m.pending && m.text.length > 3));
  assert.equal(speechRequests.length, 0, 'TTS waits for the complete response');
  await sending;
  await waitState(chat, s => s.speaking, 15_000);
  await pet.waitForFunction(() => document.getElementById('fox').classList.contains('speaking'));
  state = await chat.evaluate(() => window.friend.getState()); assert.equal(state.study.rounds, 1);
  assert.ok(state.messages.some(m => m.text === reply && !m.pending));
  assert.equal(speechRequests.length, 1);
  assert.equal(speechRequests[0].messages.at(-1).role, 'assistant');
  assert.equal(speechRequests[0].messages.at(-1).content, '先从熟悉的题目开始，我陪着你。');
  const card = JSON.parse(await readFile('assets/characters/主人的猫.json', 'utf8'));
  const prompt = requests[0].messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  // Compare exact source paragraphs after ST macro substitution. Never output their contents.
  const userName = state.settings.userName;
  const activeEntries = card.data.character_book.entries.map(entry => {
    const transformed = entry.content.replaceAll('{{user}}', userName).replaceAll('{{char}}', card.data.name);
    return { id: entry.id, included: prompt.includes(transformed) };
  });
  assert.equal(activeEntries.filter(e => e.included).length, 8, `worldbook inclusion: ${JSON.stringify(activeEntries)}`);
  assert.ok(prompt.includes('高等数学：导数'));
  assert.equal(prompt.includes(titleA) || prompt.includes(titleB), false, 'window observations are not sent to the dialogue API');
  await chat.evaluate(() => window.friend.send('结束学习'));
  await waitState(chat, s => s.study.mode === 'break' && !s.busy);
  state = await chat.evaluate(() => window.friend.getState()); assert.equal(state.study.rounds, 1, 'automatic break opening does not count as a round');
  assert.equal(state.foreground.status, 'inactive'); assert.equal(state.foreground.current, null); assert.equal(state.foreground.lastExternal, null);
  assert.equal((await readFile(path.join(dataDirectory, 'session.json'), 'utf8')).includes(titleB), false, 'window observations are not persisted');
  const breakRequests = requests.length;
  await chat.evaluate(() => window.friend.control('end')); await chat.waitForTimeout(200);
  assert.equal(requests.length, breakRequests, 'duplicate end does not repeat break opening');
  await chat.evaluate(() => window.friend.control('start')); state = await chat.evaluate(() => window.friend.getState());
  assert.equal(state.study.rounds, 0); assert.ok(state.study.elapsedMs < 1000);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  assert.equal((await chat.evaluate(() => window.friend.getState())).study.mode, 'paused');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal((await chat.evaluate(() => window.friend.getState())).study.mode, 'study');
  await chat.evaluate(() => window.friend.control('pause'));
  assert.equal((await chat.evaluate(() => window.friend.getState())).foreground.current, null, 'manual pause clears window observations');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal((await chat.evaluate(() => window.friend.getState())).study.mode, 'paused', 'manual pause remains paused after resume');
  const speechCount = speechRequests.length;
  await chat.evaluate(() => window.friend.send('模拟服务错误'));
  state = await chat.evaluate(() => window.friend.getState());
  assert.equal(state.study.rounds, 0); assert.equal(state.messages.at(-1).failed, true);
  assert.equal(speechRequests.length, speechCount, 'failed replies are not synthesized');
  await chat.evaluate(() => window.friend.control('resume'));
  await chat.evaluate(() => window.friend.send('继续做题吧。'));
  assert.equal((await chat.evaluate(() => window.friend.getState())).study.rounds, 1);
  // P1 regressions use this test-owned app/data directory and local provider.
  await chat.evaluate(() => window.friend.action('stop-audio'));
  const mutedCount = speechRequests.length;
  const muted = chat.evaluate(() => window.friend.send('P1慢速静音'));
  await waitState(chat, s => s.busy && s.messages.some(m => m.pending && m.text.length > 3));
  await chat.evaluate(() => window.friend.action('stop-audio')); await muted; await chat.waitForTimeout(100);
  assert.equal(speechRequests.length, mutedCount, 'stop audio also fences the late TTS for that request');
  const roundsBeforeCancel = (await chat.evaluate(() => window.friend.getState())).study.rounds;
  const cancelled = chat.evaluate(() => window.friend.send('P1慢速取消'));
  await waitState(chat, s => s.busy && s.messages.some(m => m.pending && m.text.length > 3));
  const settingsRejected = await chat.evaluate(async () => { try { await window.friend.saveSettings({userName:'不应提交'}); return false; } catch { return true; } });
  assert.equal(settingsRejected, true, 'settings cannot mutate a generating session');
  await chat.locator('#stop-generation').click(); await cancelled;
  state = await chat.evaluate(() => window.friend.getState());
  assert.equal(state.busy, false); assert.equal(state.messages.at(-1).cancelled, true); assert.equal(state.study.rounds, roundsBeforeCancel);
  assert.equal(speechRequests.length, mutedCount); assert.ok(abortedStreams >= 1, 'cancellation closes real upstream connection');
  assert.equal(state.tavernReady, true, 'cooperative cancellation keeps the runtime usable');
  const disrupted = chat.evaluate(() => window.friend.send('P1慢速服务中断'));
  await waitState(chat, s => s.busy && s.messages.some(m => m.pending && m.text.length > 3));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http://127.0.0.1')).destroy());
  await disrupted; await waitState(chat, s => !s.tavernReady && !s.busy);
  await chat.locator('#restart-tavern').click(); await waitState(chat, s => s.tavernReady && !s.configuring, 100_000);
  await chat.evaluate(() => window.friend.send('服务恢复后继续做题。'));
  state = await chat.evaluate(() => window.friend.getState());assert.equal(state.study.rounds, roundsBeforeCancel + 1);
  assert.equal(state.bookEntries, 8);
  await chat.evaluate(() => window.friend.control('pause'));
  const blockedTemp = path.join(dataDirectory, 'session.json.tmp');
  // Only this exact empty directory in the isolated test profile is removed.
  await mkdir(blockedTemp);
  try {
    await chat.evaluate(() => window.friend.control('resume'));
    await waitState(chat, s => s.persistence.status === 'error' && s.persistence.dirty);
    assert.equal((await chat.evaluate(() => window.friend.getState())).study.mode, 'study');
    assert.equal(await chat.locator('#save-warning').isVisible(), true);
    await chat.evaluate(() => window.friend.action('quit'));
    await waitState(chat, s => !!s.exitWarning, 10_000);
    assert.equal(app.process().exitCode, null, 'failed saving cancels quit instead of silently losing progress');
  } finally { await rmdir(blockedTemp); }
  await chat.evaluate(() => window.friend.action('retry-save'));
  await waitState(chat, s => s.persistence.status === 'saved' && !s.persistence.dirty && !s.exitWarning);
  const diskState = JSON.parse(await readFile(path.join(dataDirectory, 'session.json'), 'utf8'));
  assert.equal(diskState.study.mode, 'study');
  assert.equal(await chat.locator('#save-warning').isVisible(), false);
  await chat.evaluate(() => window.friend.control('pause'));
  await chat.evaluate(() => window.friend.action('stop-audio'));
  await mkdir('docs/screenshots', { recursive: true });
  const prefix = packaged ? 'packaged' : 'prototype';
  await chat.screenshot({ path: `docs/screenshots/${prefix}-chat.png` });
  await pet.screenshot({ path: `docs/screenshots/${prefix}-pet.png`, omitBackground: true });
  await chat.evaluate(() => window.friend.action('hide'));
  const beforeDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('pet.html')).getPosition());
  const foxBounds = await pet.locator('#fox').boundingBox();
  await pet.mouse.move(foxBounds.x + foxBounds.width / 2, foxBounds.y + foxBounds.height / 2);
  await pet.mouse.down();
  await pet.mouse.move(foxBounds.x + foxBounds.width / 2 - 25, foxBounds.y + foxBounds.height / 2 - 25, { steps: 4 });
  await pet.mouse.up();
  const afterDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('pet.html')).getPosition());
  assert.notDeepEqual(afterDrag, beforeDrag, 'drag moves the actual desktop window');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).isVisible()), false, 'drag does not open chat');
  await pet.locator('#fox').click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).isVisible()), true);
  const report = { passed: true, appVersion: version, packaged, testedAt: new Date().toISOString(), mode: 'local-mock-provider-with-real-SillyTavern', tavernVersion: '1.19.0', activeWorldbookEntries: activeEntries, stream: true, ttsSpeechOnly: true, petSpeechState: true, nativePetDrag: true, clickOpensChat: true, studyControls: true, systemEvents: 'simulated suspend/resume and lock/unlock', nativeWindowObservation: { browser: 'real Microsoft Edge with isolated test pages', processAndPath: true, unicodeTitle: true, changedTitle: true, recentExternalRetained: true, lastExternalClearlyLabelled: true, titleDisplayedInUI: true, stopsOnPauseBreakLockAndDisable: true, noUploadOrPersistence: true, bilibiliPlaybackTested: false }, serviceErrorRecovery: true, realProviderTested: false, screenshots: [`docs/screenshots/${prefix}-chat.png`, `docs/screenshots/${prefix}-pet.png`, 'docs/screenshots/window-observation.png'] };
  report.p1Regressions = { lateTTSFenced: true, stopReplyButton: true, cancelledRoundNotCounted: true, upstreamStreamAborted: abortedStreams >= 1, settingsRejectedDuringGeneration: true, runtimeFailureSettlesBusy: true, restartKeepsWorldbook: true, actualDiskFailureVisible: true, failedSaveCancelsQuit: true, retrySavesLatestSnapshot: true };
  await writeFile(`docs/${packaged ? 'packaged-' : ''}integration-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.stack);
  if (app) {
    for (const window of app.windows()) {
      const url = window.url();
      console.error('Window:', url);
      if (url.includes('127.0.0.1')) console.error(await window.evaluate(() => ({ bridge: !!window.friendBridge, ctx: !!window.SillyTavern, ready: window.SillyTavern?.getContext()?.onlineStatus, dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.innerText.slice(0, 100)) })).catch(() => ({})));
    }
  }
  process.exitCode = 1;
} finally { if (browser) await browser.close(); if (app) await app.close(); mock.closeAllConnections(); mock.close(); }
