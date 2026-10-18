import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ArchivedTask, ArchiveSummary, ChatReference, ChatMessage, SegmentHistory, StudySnapshot, TaskSummary } from './types';
import type { SaveStatus } from './persistence';

interface Library {
  version: 1; tasks: ArchivedTask[]; currentChat?: ChatReference;
  activeTaskId?: string; activeSegmentId?: string; hiddenIds: string[]; study?: StudySnapshot;
}
const empty = (): Library => ({ version: 1, tasks: [], hiddenIds: [] });
const sameChat = (a?: ChatReference, b?: ChatReference) => a?.avatar === b?.avatar && a?.fileName === b?.fileName;

/** Metadata only: the original Tavern JSONL remains the source of conversation text. */
export class ConversationArchive {
  private value: Library = empty();
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;
  private status: SaveStatus = { status: 'saved', dirty: false };
  constructor(private directory: string, private onChange: () => void = () => {}) {}
  async load() {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, 'chat-library.json'), 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.hiddenIds)) throw new Error('Invalid library');
      this.value = parsed;
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('聊天归档索引无法读取，原聊天文件仍保留，请检查本机数据'); }
  }
  summary(): ArchiveSummary { return { revision: this.revision, taskCount: this.value.tasks.length, activeTaskId: this.value.activeTaskId, activeSegmentId: this.value.activeSegmentId }; }
  snapshot() { return structuredClone(this.value); }
  saveStatus(): SaveStatus { return { ...this.status }; }
  async flush() { await this.writes; }
  private commit(change: (draft: Library) => void) {
    const task = this.writes.catch(() => {}).then(async () => {
      const next = structuredClone(this.value); change(next);
      this.status = { status: 'saving', dirty: true }; this.onChange();
      try {
        await mkdir(this.directory, { recursive: true });
        const file = path.join(this.directory, 'chat-library.json');
        await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf8'); await rename(`${file}.tmp`, file);
        this.value = next; this.revision++;
        this.status = { status: 'saved', dirty: false, lastSavedAt: Date.now() };
      } catch (error) {
        this.status = { status: 'error', dirty: true, error: '聊天归档未保存，聊天仍保留。请重试当前操作。' }; throw error;
      } finally { this.onChange(); }
    });
    this.writes = task; return task;
  }
  newChat(avatar: string): ChatReference { return { avatar, fileName: `Friend-${randomUUID()}` }; }
  private chatPath(chat: ChatReference) {
    if (!chat.avatar.endsWith('.png') || [chat.avatar, chat.fileName].some(value => !value || /[\\/\x00]/.test(value) || value === '.' || value === '..')) throw new Error('聊天文件标识不正确');
    const root = path.resolve(this.directory, 'tavern-data/default-user/chats');
    const target = path.resolve(root, chat.avatar.slice(0, -4), `${chat.fileName}.jsonl`);
    if (!target.startsWith(root + path.sep)) throw new Error('聊天文件位置不正确');
    return target;
  }
  private async readMessages(chat: ChatReference): Promise<ChatMessage[]> {
    const text = await readFile(this.chatPath(chat), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(1)
      .filter(message => !message.is_system).map((message, index) => ({ id: `st-${message.extra?.friend_message_id ?? index}`,
        role: message.is_user ? 'user' : 'assistant', text: String(message.mes ?? ''),
        ...(Number.isFinite(Date.parse(message.send_date)) ? { createdAt: Date.parse(message.send_date) } : {}),
      }));
  }
  async initialize(chat: ChatReference, messages: ChatMessage[], study: StudySnapshot) {
    if (this.value.currentChat) return;
    const legacy: { chat: ChatReference; hasMessages: boolean }[] = [];
    const folder = path.dirname(this.chatPath(chat));
    for (const entry of await readdir(folder, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const ref = { avatar: chat.avatar, fileName: entry.name.slice(0, -6) };
      const content = await this.readMessages(ref); legacy.push({ chat: ref, hasMessages: content.length > 0 });
    }
    await this.commit(draft => {
      draft.currentChat = chat; draft.study = study;
      const now = Date.now();
      for (const item of legacy) {
        if (!item.hasMessages && !(sameChat(item.chat, chat) && study.mode !== 'idle')) continue;
        const active = sameChat(item.chat, chat) && study.mode !== 'idle';
        const task: ArchivedTask = { id: randomUUID(), title: active ? study.topic || '升级前学习任务' : '升级前聊天记录', kind: active ? 'study' : 'legacy', imported: true,
          startedAt: now, ...(active ? {} : { endedAt: now }), segments: [{ id: randomUUID(), number: active ? Math.max(1, study.segment) : 1, topic: active ? study.topic : '未分段的旧聊天',
            startedAt: now, ...(active && study.mode !== 'break' ? {} : { endedAt: now }), durationMs: active ? study.elapsedMs : 0, chat: item.chat }] };
        draft.tasks.push(task);
        if (active) { draft.activeTaskId = task.id; draft.activeSegmentId = task.segments[0].id; }
      }
      // A new install has an empty selected chat and therefore no legacy row.
      if (study.mode !== 'idle' && !draft.activeTaskId) {
        const task: ArchivedTask = { id: randomUUID(), title: study.topic || '学习任务', kind: 'study', imported: true, startedAt: now,
          segments: [{ id: randomUUID(), number: Math.max(1, study.segment), topic: study.topic, startedAt: now, durationMs: study.elapsedMs, chat }] };
        draft.tasks.push(task); draft.activeTaskId = task.id; draft.activeSegmentId = task.segments[0].id;
      }
      if (study.mode === 'idle' && messages.length) draft.currentChat = this.newChat(chat.avatar);
    });
  }
  private keepFreeChat(draft: Library, chat: ChatReference, hasMessages: boolean) {
    if (!hasMessages || draft.tasks.some(task => task.segments.some(segment => sameChat(segment.chat, chat)))) return;
    const now = Date.now();
    draft.tasks.push({ id: randomUUID(), title: '自由聊天', kind: 'free', startedAt: now, endedAt: now,
      segments: [{ id: randomUUID(), number: 1, topic: '自由聊天', startedAt: now, endedAt: now, durationMs: 0, chat }] });
  }
  async startSegment(topic: string, planned: StudySnapshot, previous: ChatReference, hasMessages: boolean) {
    const next = this.newChat(previous.avatar);
    await this.commit(draft => {
      if (!draft.activeTaskId) this.keepFreeChat(draft, previous, hasMessages);
      let task = draft.tasks.find(task => task.id === draft.activeTaskId);
      if (!task) { task = { id: randomUUID(), title: topic || '自主学习', kind: 'study', startedAt: Date.now(), segments: [] }; draft.tasks.push(task); }
      const segment = { id: randomUUID(), number: (task.segments.at(-1)?.number ?? 0) + 1, topic, startedAt: Date.now(), durationMs: 0, chat: next };
      task.segments.push(segment); draft.activeTaskId = task.id; draft.activeSegmentId = segment.id;
      draft.currentChat = next; draft.hiddenIds = []; draft.study = planned;
    });
    return next;
  }
  async endSegment(planned: StudySnapshot, hiddenIds: string[]) {
    await this.commit(draft => {
      const segment = draft.tasks.find(task => task.id === draft.activeTaskId)?.segments.find(segment => segment.id === draft.activeSegmentId);
      if (!segment) throw new Error('当前学习段尚未建立，请重启对话服务');
      segment.endedAt ??= Date.now(); segment.durationMs = planned.elapsedMs;
      draft.hiddenIds = hiddenIds; draft.study = planned;
    });
  }
  async finishTask(planned: StudySnapshot, finalDuration: number, previous: ChatReference) {
    const next = this.newChat(previous.avatar);
    await this.commit(draft => {
      const task = draft.tasks.find(task => task.id === draft.activeTaskId);
      if (task) {
        const segment = task.segments.find(segment => segment.id === draft.activeSegmentId);
        if (segment && !segment.endedAt) { segment.endedAt = Date.now(); segment.durationMs = finalDuration; }
        task.endedAt = Date.now();
      }
      draft.activeTaskId = undefined; draft.activeSegmentId = undefined; draft.hiddenIds = []; draft.currentChat = next; draft.study = planned;
    });
    return next;
  }
  async update(study: StudySnapshot, expectedSegmentId = this.value.activeSegmentId) {
    if (this.status.status === 'saving') await this.writes.catch(() => {});
    await this.commit(draft => {
      if (draft.activeSegmentId !== expectedSegmentId || (draft.study?.segment !== study.segment && expectedSegmentId)) return;
      const phase = (mode: StudySnapshot['mode']) => ['study', 'paused'].includes(mode) ? 'learning' : mode;
      if (draft.study && phase(draft.study.mode) !== phase(study.mode)) return;
      draft.study = study;
      const segment = draft.tasks.find(task => task.id === draft.activeTaskId)?.segments.find(segment => segment.id === expectedSegmentId);
      if (segment && !segment.endedAt) segment.durationMs = study.elapsedMs;
    });
  }
  visible(messages: ChatMessage[]) { const hidden = new Set(this.value.hiddenIds); return messages.filter(message => !hidden.has(message.id)); }
  list(): TaskSummary[] {
    return this.value.tasks.map(({ segments, ...task }) => ({ ...task, segmentCount: segments.length,
      durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0) })).reverse();
  }
  getTask(id: string): ArchivedTask {
    const task = this.value.tasks.find(task => task.id === id); if (!task) throw new Error('该任务不存在'); return structuredClone(task);
  }
  async getSegment(taskId: string, segmentId: string): Promise<SegmentHistory> {
    const task = this.getTask(taskId), segment = task.segments.find(segment => segment.id === segmentId);
    if (!segment) throw new Error('该学习段不存在');
    return { taskId, taskTitle: task.title, segment, messages: await this.readMessages(segment.chat) };
  }
}
