import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeChatHistory } from '../src/chat-history';
import type { ChatMessage } from '../src/types';
const message = (id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({ id, role, text: id });
const ids = (messages: ChatMessage[]) => messages.map(message => message.id);

test('old end/start notices stay before the new two-round conversation after canonical IDs replace pending IDs', () => {
  const end = message('old-end', 'notice'), start = message('new-start', 'notice');
  const first = [message('st-u1', 'user'), message('st-a1')];
  const pending = [message('pending-user', 'user'), message('pending-assistant')];
  const merged = mergeChatHistory(first, [end, start, ...pending]);
  assert.deepEqual(ids(merged), ['old-end', 'new-start', 'st-u1', 'st-a1']);
  const second = [message('st-u2', 'user'), message('st-a2')];
  const twice = mergeChatHistory([...first, ...second], [...merged, ...pending]);
  assert.deepEqual(ids(twice), ['old-end', 'new-start', 'st-u1', 'st-a1', 'st-u2', 'st-a2']);
});

test('configure, editing, regeneration and deleting an anchor preserve notices between surviving messages', () => {
  const left = message('st-left'), right = message('st-right'), notice = message('between', 'notice');
  const original = [left, notice, right];
  assert.deepEqual(ids(mergeChatHistory([left, right], original)), ['st-left', 'between', 'st-right']);
  assert.deepEqual(ids(mergeChatHistory([{ ...left, text: 'edited' }, right], original)), ['st-left', 'between', 'st-right']);
  assert.deepEqual(ids(mergeChatHistory([left, message('st-regenerated')], original)), ['st-left', 'between', 'st-regenerated']);
  assert.deepEqual(ids(mergeChatHistory([right], original)), ['between', 'st-right']);
  assert.deepEqual(ids(mergeChatHistory([left], original)), ['st-left', 'between']);
  assert.deepEqual(ids(mergeChatHistory([], original)), ['between']);
});

test('a notice after a just-generated reply keeps its position when no ID has been canonicalized yet', () => {
  const local = [message('temporary-u', 'user'), message('temporary-a'), message('tts-failure', 'notice')];
  assert.deepEqual(ids(mergeChatHistory([message('st-u', 'user'), message('st-a')], local)), ['st-u', 'st-a', 'tts-failure']);
  const prefix = [message('st-old-u', 'user'), message('st-old-a')];
  assert.deepEqual(ids(mergeChatHistory([...prefix, message('st-u', 'user'), message('st-a')], [...prefix, ...local])),
    ['st-old-u', 'st-old-a', 'st-u', 'st-a', 'tts-failure']);
});
