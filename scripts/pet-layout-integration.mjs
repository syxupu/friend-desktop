// Isolated DOM regression checks. This mock bridge does not validate Tavern/model behavior.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } }), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let state = { settings: { petScale: 1 }, study: { mode: 'idle' }, busy: false, configuring: false, tavernReady: true, messages: [], character: '中性长名称'.repeat(50), speaking: false }, update;
    window.__sent = []; window.__moves = [];
    window.friend = {
      getState: async () => state, onState: callback => { update = callback; }, layoutPet() {}, action: async () => {},
      movePet: (x, y) => window.__moves.push({ x, y }),
      send: async text => {
        window.__sent.push(text); state = { ...state, busy: true }; update(state);
        await new Promise(resolve => setTimeout(resolve, 30));
        state = { ...state, busy: false, messages: [{ id: 'mock-sent', role: 'assistant', text: '模拟桥接回复完成' }] }; update(state);
      },
    };
    window.__update = patch => { state = { ...state, ...patch }; update(state); };
  });
  await page.goto(pathToFileURL(path.resolve('dist/pet.html')).href);
  await page.waitForFunction(() => !document.getElementById('pet-send').disabled);
  for (const scale of [.5, 1, 1.5, 2]) for (const viewport of [800, 1200, 1800]) {
    await page.setViewportSize({ width: viewport, height: 950 });
    await page.evaluate(scale => window.__update({ settings: { petScale: scale }, messages: [{ id: 'long-fixture', role: 'assistant', text: 'UNBROKEN_TEXT_'.repeat(500) }] }), scale);
    const size = await page.evaluate(() => {
      const bounds = id => document.getElementById(id).getBoundingClientRect();
      const form = bounds('pet-form'), input = bounds('pet-input'), button = bounds('pet-send');
      return { shell: bounds('pet-shell').width, form: form.width, reply: bounds('pet-reply').width, controlsFit: input.left >= form.left && input.right <= button.left && button.right <= form.right };
    });
    assert.equal(size.shell, Math.round(324 * scale)); assert.equal(size.form, size.shell - 20); assert.equal(size.reply, size.form); assert.ok(size.controlsFit);
  }
  await page.evaluate(() => window.__update({ settings: { petScale: 1 } }));
  const fox = page.locator('#fox'); let rect = await fox.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 40, rect.y + rect.height / 2 + 10, { steps: 4 }); await page.mouse.up();
  assert.ok((await page.evaluate(() => window.__moves)).length > 0); assert.ok(!await fox.evaluate(element => element.classList.contains('dragging')));
  rect = await fox.boundingBox(); await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 30, rect.y + rect.height / 2);
  await fox.evaluate(element => element.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 })));
  await page.mouse.up(); assert.ok(!await fox.evaluate(element => element.classList.contains('dragging')));
  await page.locator('#pet-input').fill('拖动后继续输入'); await page.locator('#pet-send').click();
  await page.waitForFunction(() => document.getElementById('reply-text').textContent === '模拟桥接回复完成');
  assert.deepEqual(await page.evaluate(() => window.__sent), ['拖动后继续输入']); assert.ok(await page.locator('#pet-send').isEnabled()); assert.deepEqual(errors, []);
  console.log('PASS mock-bridge UI: fixed widths across 4 scales and 3 viewport widths, long text/title containment, drag/capture cleanup and post-drag send');
} finally { await browser.close(); }
