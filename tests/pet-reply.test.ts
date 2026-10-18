import test from 'node:test';
import assert from 'node:assert/strict';
import { mainFixture, deferred } from './main-fixture';
import type { ChatMessage } from '../src/types';
const rounds = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => [
  { id: `st-u${i + 1}`, role: 'user' as const, text: `question ${i + 1}` },
  { id: `st-a${i + 1}`, role: 'assistant' as const, text: `answer ${i + 1}` },
]).flat();
test('deleting the latest reply suppresses old replies only after Tavern acknowledges the write', async () => {
  const f = mainFixture(); let history = rounds(4);
  try {
    f.bridge.call = async () => ({ character: 'Neutral', entries: 0, messages: history }); await f.api.saveSettings({});
    const pending = deferred(); f.bridge.call = async () => pending.promise;
    const deletion = f.api.changeMessage({ action: 'delete', id: 'st-a4', expectedText: 'answer 4' });
    assert.equal(f.api.inspect().petReplySuppressed, false); assert.ok(f.api.inspect().messages.some((m: ChatMessage) => m.id === 'st-a4'));
    history = history.filter(message => message.id !== 'st-a4'); pending.resolve({ messages: history }); await deletion;
    assert.equal(f.api.inspect().petReplySuppressed, true);
    f.bridge.call = async () => ({ character: 'Neutral', entries: 0, messages: history });
    await f.api.saveSettings({}); assert.equal(f.api.inspect().petReplySuppressed, true);
    history = history.filter(message => message.id !== 'st-a2');
    await f.api.changeMessage({ action: 'delete', id: 'st-a2', expectedText: 'answer 2' }); assert.equal(f.api.inspect().petReplySuppressed, true);
  } finally { await f.cleanup(); }
});
test('for n rounds deleting each i-th reply with i < n keeps the latest n-th reply selected', async () => {
  for (const n of [2, 5, 10]) for (let i = 1; i < n; i++) {
    const f = mainFixture(); let history = rounds(n);
    try {
      f.bridge.call = async () => ({ character: 'Neutral', entries: 0, messages: history }); await f.api.saveSettings({});
      history = history.filter(message => message.id !== `st-a${i}`);
      await f.api.changeMessage({ action: 'delete', id: `st-a${i}`, expectedText: `answer ${i}` });
      const state = f.api.inspect(); assert.equal(state.petReplySuppressed, false); assert.equal(state.messages.findLast((m: ChatMessage) => m.role === 'assistant')?.id, `st-a${n}`);
    } finally { await f.cleanup(); }
  }
});
test('failed deletion keeps the displayed reply, and a fresh generation reopens a suppressed bubble', async () => {
  const f = mainFixture(); const generate = f.bridge.call.bind(f.bridge); let history = rounds(2);
  try {
    f.bridge.call = async () => ({ character: 'Neutral', entries: 0, messages: history }); await f.api.saveSettings({});
    f.bridge.call = async () => { throw new Error('native write failure'); };
    await assert.rejects(f.api.changeMessage({ action: 'delete', id: 'st-a2', expectedText: 'answer 2' })); assert.equal(f.api.inspect().petReplySuppressed, false);
    history = history.filter(message => message.id !== 'st-a2'); f.bridge.call = async () => ({ messages: history });
    await f.api.changeMessage({ action: 'delete', id: 'st-a2', expectedText: 'answer 2' }); assert.equal(f.api.inspect().petReplySuppressed, true);
    f.bridge.call = generate; const running = f.api.generate('next question'); assert.equal(f.api.inspect().petReplySuppressed, false);
    f.reply('new answer'); await running; assert.equal(f.api.inspect().petReplySuppressed, false);
  } finally { await f.cleanup(); }
});
test('cancelled regeneration of older remaining history preserves suppression and the original reply', async () => {
  const f = mainFixture(); const generate = f.bridge.call.bind(f.bridge); let history = rounds(3);
  try {
    f.bridge.call = async () => ({ character: 'Neutral', entries: 0, messages: history }); await f.api.saveSettings({});
    history = history.filter(message => message.id !== 'st-a3'); f.bridge.call = async () => ({ messages: history });
    await f.api.changeMessage({ action: 'delete', id: 'st-a3', expectedText: 'answer 3' });
    // Delete the trailing user message so the remaining assistant is eligible for regeneration.
    history = history.filter(message => message.id !== 'st-u3');
    await f.api.changeMessage({ action: 'delete', id: 'st-u3', expectedText: 'question 3' });
    f.bridge.call = generate;
    const running = f.api.changeMessage({ action: 'regenerate', id: 'st-a2', expectedText: 'answer 2' });
    assert.equal(f.api.inspect().petReplySuppressed, false); await f.api.cancelGeneration(); await running;
    assert.equal(f.api.inspect().petReplySuppressed, true); assert.equal(f.api.inspect().messages.at(-1).text, 'answer 2');
  } finally { await f.cleanup(); }
});
