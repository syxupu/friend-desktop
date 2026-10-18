import test from 'node:test';
import assert from 'node:assert/strict';
import { StudySession, explicitCommand } from '../src/study';
import { extractSpeech } from '../src/speech';

test('manual study segments, system sleep, duplicate controls and accumulated effective time', () => {
  let now = 0; const session = new StudySession(() => now);
  assert.equal(session.start('数学'), true); now = 60_000;
  assert.equal(session.start(), false); assert.equal(session.snapshot().elapsedMs, 60_000);
  session.pause(true); now = 100_000; assert.equal(session.snapshot().elapsedMs, 60_000);
  session.resume(true); now = 130_000; session.end();
  assert.equal(session.snapshot().elapsedMs, 90_000); assert.equal(session.snapshot().mode, 'break');
  assert.equal(session.end(), false); assert.equal(session.snapshot().taskElapsedMs, 90_000);
  session.start(); assert.equal(session.snapshot().elapsedMs, 0);
  session.pause(); assert.equal(session.resume(true), false, 'wake must not undo a manual pause');
});
test('chat warning is once per segment and only valid completed rounds count', () => {
  const session = new StudySession(); session.start(); const segment = session.snapshot().segment;
  for (let n = 0; n < 29; n++) assert.equal(session.completeRound(segment), false);
  assert.equal(session.completeRound(segment), true);
  assert.equal(session.completeRound(segment), false);
  session.end(); assert.equal(session.completeRound(segment), false);
  session.start(); assert.equal(session.snapshot().rounds, 0); assert.equal(session.snapshot().chatReminderSent, false);
  assert.equal(session.completeRound(segment), false, 'a reply from a prior segment is not counted');
});
test('only exact user commands alter state', () => {
  assert.equal(explicitCommand('开始学习！'), 'start');
  for (const text of ['等会儿该学习了', '她说“开始学习”', '请不要结束学习', '开始学习以后聊聊']) assert.equal(explicitCommand(text), null);
});
test('restart restores accrued time as paused without counting offline time', () => {
  let now = 0; const first = new StudySession(() => now); first.start('数学'); now = 12_345; first.completeRound(first.snapshot().segment);
  const restored = new StudySession(() => 999_999); restored.restore(first.snapshot());
  assert.equal(restored.snapshot().mode, 'paused'); assert.equal(restored.snapshot().elapsedMs, 12_345);
  assert.equal(restored.snapshot().rounds, 1); assert.equal(restored.resume(true), false);
});

test('finishing a task immediately resets displayed time and rounds while preserving its completed total', () => {
  let now = 0; const session = new StudySession(() => now);
  session.start('第一段'); now = 25000; session.end(); session.start('第二段'); now = 55000;
  session.completeRound(session.snapshot().segment); session.finish();
  assert.equal(session.snapshot().elapsedMs, 0); assert.equal(session.snapshot().rounds, 0);
  assert.equal(session.snapshot().taskElapsedMs, 55000); assert.equal(session.snapshot().mode, 'idle');
  session.start('新任务'); assert.equal(session.snapshot().taskElapsedMs, 0); assert.equal(session.snapshot().segment, 1);
  session.finish(); const restored = new StudySession(); restored.restore({ ...session.snapshot(), elapsedMs: 99999 });
  assert.equal(restored.snapshot().elapsedMs, 0);
});
test('speech extraction keeps dialogue and excludes narration, reasoning, actions and code', () => {
  assert.equal(extractSpeech('*她看向试卷。* “先做这道题（轻声）。”\n她笑了。\n「我陪着你。」'), '先做这道题。\n我陪着你。');
  assert.equal(extractSpeech('<think>“不要播报推理。”</think><say>我们开始吧。</say>旁白。'), '我们开始吧。');
  assert.equal(extractSpeech('她整理试卷，安静坐在一旁。'), '');
  assert.equal(extractSpeech('```js\n"secret"\n```\n“加油。”'), '加油。');
});
