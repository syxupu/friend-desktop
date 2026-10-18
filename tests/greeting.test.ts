import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const greeting = { mes: 'CARD_GREETING', is_user: false, is_system: false, extra: {} };
async function fixture(chat: any[] = [structuredClone(greeting)]) {
  const events = new Map<string, (...args: any[]) => void>();
  let disk: any[] = [{ chat_metadata: { integrity: 'fixture' } }, ...structuredClone(chat)], failSave = false, generated = 0;
  let input = '', saveGate: Promise<void> | undefined, saving = false; const prompts: any[] = [];
  const character = { avatar: 'neutral.png', chat: 'old', name: 'Neutral', first_mes: greeting.mes,
    data: { extensions: { world: 'fixture' }, alternate_greetings: ['ALTERNATE_GREETING'] } };
  const ctx: any = { chat, characters: [character], characterId: 0, groupId: null, chatMetadata: { integrity: 'fixture' },
    powerUserSettings: {}, chatCompletionSettings: {}, name1: 'User', name2: 'Neutral', getRequestHeaders: () => ({}), stopGeneration: async () => {},
    selectCharacterById: async () => {}, saveSettingsDebounced() {}, setExtensionPrompt() {},
    eventSource: { on: (name: string, fn: any) => events.set(name, fn) }, eventTypes: { MESSAGE_RECEIVED: 'received' },
    openCharacterChat: async (file: string) => { character.chat = file; ctx.chat.splice(0, ctx.chat.length, ...(disk.length > 1 ? structuredClone(disk.slice(1)) : [structuredClone(greeting)])); },
    generate: async () => {
      generated++; prompts.push(structuredClone(ctx.chat));
      if (input) ctx.chat.push({ mes: input, is_user: true, extra: {} });
      ctx.chat.push({ mes: 'GENERATED_REPLY', is_user: false, gen_started: '2026-10-18', extra: { api: 'mock' } });
      events.get('received')!(ctx.chat.length - 1);
    } };
  const script: any = { eventSource: { on: (_: string, fn: any) => queueMicrotask(fn) }, event_types: {},
    setUserName() {}, changeMainAPI() {}, setOnlineStatus() {}, isGenerating: () => false, printMessages: async () => {}, extension_prompt_types: { IN_CHAT: 0 } };
  const mocks: any = { '/script.js': script, '/scripts/world-info.js': { world_names: ['fixture'] },
    '/scripts/secrets.js': { writeSecret: async () => {}, SECRET_KEYS: {} },
    '/scripts/extensions/regex/engine.js': { getRegexedString: (text: string) => text, regex_placement: { AI_OUTPUT: 2 } } };
  const window: any = { SillyTavern: { getContext: () => ctx }, friendTavern: { report() {} },
    $: () => ({ val(value: string) { input = value; return this; }, trigger() { return this; } }) };
  const code = readFileSync('src/tavern-bridge.js', 'utf8').replace(/await import\(([^)]+)\)/g, 'await mockImport($1)');
  await vm.runInNewContext(code, { window, structuredClone, crypto: { randomUUID }, Date, mockImport: async (name: string) => mocks[name],
    fetch: async (url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/save')) { saving = true; await saveGate; if (failSave) return { ok: false }; disk = structuredClone(body.chat); }
      return { ok: true, json: async () => structuredClone(disk) };
    } });
  return { bridge: window.friendBridge, ctx, character, prompts, disk: () => disk, generated: () => generated,
    failSave: () => { failSave = true; }, emptyDisk: () => { disk = []; },
    holdSave: (gate: Promise<void>) => { saveGate = gate; saving = false; }, saving: () => saving };
}
const config = { avatar: 'neutral.png', userName: 'User', url: 'http://local', token: 'fictional', model: 'mock' };

test('configure removes only the leading card greeting, preserving real history and an on-disk backup', async () => {
  const f = await fixture([structuredClone(greeting), { mes: 'USER', is_user: true, extra: {} }, { mes: 'REPLY', is_user: false, gen_started: 'date', extra: {} }]);
  const result = await f.bridge.configure(config);
  assert.deepEqual(Array.from(result.messages, (m: any) => m.text), ['USER', 'REPLY']);
  assert.equal(f.disk()[0].chat_metadata.friend_greeting_backup.message.mes, greeting.mes);
  assert.equal(f.disk().length, 3); assert.equal(f.character.first_mes, greeting.mes);
});

test('new free chats ignore legacy allowGreeting and remain empty after reopening', async () => {
  const f = await fixture(); await f.bridge.configure(config); f.emptyDisk();
  const ref = { avatar: 'neutral.png', fileName: 'new', allowGreeting: true };
  assert.equal((await f.bridge.openConversation({ chat: ref })).messages.length, 0);
  assert.equal((await f.bridge.openConversation({ chat: ref })).messages.length, 0);
  assert.equal(f.disk().length, 1); assert.equal(f.generated(), 0);
});

test('alternate card greeting is removed before a user request reaches the generator', async () => {
  const f = await fixture([]); await f.bridge.configure(config);
  f.ctx.chat.push({ ...structuredClone(greeting), mes: 'ALTERNATE_GREETING' });
  await f.bridge.generate({ id: 'request', text: 'USER', study: { mode: 'study', elapsedMs: 0 } });
  assert.equal(f.prompts[0].length, 0);
  assert.deepEqual(f.disk().slice(1).map(m => m.mes), ['USER', 'GENERATED_REPLY']);
});

test('a generated first reply matching card text is retained, including after a refresh', async () => {
  for (const markers of [{ gen_started: 'date' }, { extra: { api: 'mock' } }, { swipe_info: [{ gen_finished: 'date' }] }]) {
    const f = await fixture([{ ...structuredClone(greeting), ...markers }]);
    await f.bridge.configure(config); assert.equal((await f.bridge.getConversation()).messages.length, 1);
    assert.equal(f.disk()[1].mes, greeting.mes);
  }
});

test('failed greeting persistence retains the original and blocks generation', async () => {
  const f = await fixture([]); await f.bridge.configure(config); f.ctx.chat.push(structuredClone(greeting)); f.failSave();
  await assert.rejects(f.bridge.generate({ id: 'request', text: 'USER', study: { mode: 'idle', elapsedMs: 0 } }), /保存失败/);
  assert.equal(f.ctx.chat[0].mes, greeting.mes); assert.equal(f.generated(), 0);
  assert.equal(f.ctx.chatMetadata.friend_greeting_backup, undefined);
});

test('cancellation while a greeting removal is saving cannot start a late producer', async () => {
  const f = await fixture([]); await f.bridge.configure(config); f.ctx.chat.push(structuredClone(greeting));
  let release!: () => void; f.holdSave(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.bridge.generate({ id: 'old', text: 'USER', study: { mode: 'study', elapsedMs: 0 } });
  while (!f.saving()) await new Promise(resolve => setImmediate(resolve));
  await f.bridge.stop(); release(); await assert.rejects(pending, /已取消/); assert.equal(f.generated(), 0);
  await f.bridge.generate({ id: 'new', text: 'NEXT', study: { mode: 'study', elapsedMs: 0 } });
  assert.equal(f.generated(), 1); assert.equal(f.prompts[0].length, 0);
});
