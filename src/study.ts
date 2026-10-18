import type { Mode, StudySnapshot } from './types';

/** One authoritative state machine. Role replies never call its controls. */
export class StudySession {
  private mode: Mode = 'idle';
  private topic = '';
  private elapsed = 0;
  private startedAt = 0;
  private taskElapsed = 0;
  private segment = 0;
  private rounds = 0;
  private chatReminderSent = false;
  private systemPaused = false;
  constructor(private clock: () => number = () => performance.now()) {}
  restore(saved: StudySnapshot) {
    if (!saved || !['idle', 'study', 'paused', 'break'].includes(saved.mode)) return;
    this.mode = saved.mode === 'study' ? 'paused' : saved.mode;
    this.topic = String(saved.topic ?? '').slice(0, 200);
    this.elapsed = Math.max(0, Number(saved.elapsedMs) || 0);
    this.taskElapsed = Math.max(0, Number(saved.taskElapsedMs) || 0);
    this.segment = Math.max(0, Number(saved.segment) || 0);
    this.rounds = Math.max(0, Number(saved.rounds) || 0);
    this.chatReminderSent = !!saved.chatReminderSent;
    this.systemPaused = false;
    if (this.mode === 'idle') { this.elapsed = 0; this.segment = 0; this.rounds = 0; this.chatReminderSent = false; }
  }
  snapshot(): StudySnapshot {
    return { mode: this.mode, topic: this.topic, elapsedMs: this.elapsed + (this.mode === 'study' ? this.clock() - this.startedAt : 0), segment: this.segment, rounds: this.rounds, chatReminderSent: this.chatReminderSent, taskElapsedMs: this.taskElapsed };
  }
  start(topic?: string) {
    if (this.mode === 'study' || this.mode === 'paused') return false;
    if (this.mode === 'idle') this.taskElapsed = 0;
    this.mode = 'study'; this.topic = topic?.trim() || this.topic || '自主学习';
    this.elapsed = 0; this.startedAt = this.clock(); this.segment++;
    this.rounds = 0; this.chatReminderSent = false; this.systemPaused = false;
    return true;
  }
  pause(system = false) {
    if (this.mode !== 'study') return false;
    this.elapsed += this.clock() - this.startedAt; this.mode = 'paused'; this.systemPaused = system;
    return true;
  }
  resume(system = false) {
    if (this.mode !== 'paused' || (system && !this.systemPaused)) return false;
    this.mode = 'study'; this.startedAt = this.clock(); this.systemPaused = false;
    return true;
  }
  end() {
    if (this.mode !== 'study' && this.mode !== 'paused') return false;
    if (this.mode === 'study') this.elapsed += this.clock() - this.startedAt;
    this.taskElapsed += this.elapsed; this.mode = 'break'; this.systemPaused = false;
    return true;
  }
  finish() {
    this.end(); this.mode = 'idle'; this.systemPaused = false;
    this.elapsed = 0; this.startedAt = 0; this.segment = 0;
    this.rounds = 0; this.chatReminderSent = false;
  }
  completeRound(segment: number): boolean {
    if (this.mode !== 'study' || segment !== this.segment) return false;
    this.rounds++;
    if (this.rounds >= 30 && !this.chatReminderSent) { this.chatReminderSent = true; return true; }
    return false;
  }
}

export function explicitCommand(text: string): 'start' | 'end' | 'pause' | 'resume' | 'finish' | null {
  const commands: Record<string, 'start' | 'end' | 'pause' | 'resume' | 'finish'> = { '开始学习': 'start', '结束学习': 'end', '暂停学习': 'pause', '继续学习': 'resume', '结束任务': 'finish' };
  return commands[text.trim().replace(/[。！!]+$/, '')] ?? null;
}
