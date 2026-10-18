import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, powerMonitor, powerSaveBlocker, screen, dialog } from 'electron';
import path from 'node:path';
import { readFile, mkdir, open, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StudySession, explicitCommand } from './study';
import { SettingsStore, publicSettings } from './settings';
import { startModelProxy } from './model-proxy';
import { fetchModels } from './providers';
import { petSize, petWidth } from './pet-layout';
import { TavernRuntime } from './tavern';
import { extractSpeech, synthesize } from './speech';
import { ForegroundMonitor, emptyForeground } from './foreground';
import { SnapshotWriter } from './persistence';
import { withDeadline } from './deadline';
import { mergeChatHistory } from './chat-history';
import { ConversationArchive } from './archive';
import { ChatDeletion } from './chat-deletion';
import { loreDocument, removeLore } from './lore';
import { decodeCharacterCard, maxCardBytes, validAvatar } from './character-card';
import { CompanionStore, defaultPreferences, companionPrompt, fieldsFromData, revisionOf, validateFields, validatePreferences } from './companions';
import type { AppState, ChatMessage, Settings, MessageChange, CharacterDocument, CharacterSave } from './types';

const testing = process.argv.includes('--integration-test');
if (testing) app.setPath('userData', process.env.FRIEND_TEST_DATA || path.join(app.getAppPath(), '.test-data', process.env.FRIEND_TEST_ID || 'integration'));
if (!testing && !app.requestSingleInstanceLock()) app.quit();
const root = app.getAppPath();
const study = new StudySession();
let chatWindow: BrowserWindow;
let petWindow: BrowserWindow;
let petContentHeight = 0;
let fetchingModels = false;
let tavern: TavernRuntime;
let store: SettingsStore;
let tray: Tray;
let proxy: Awaited<ReturnType<typeof startModelProxy>>;
let ready = false, busy = false, speaking = false, quitting = false;
let configuring = false, allowQuit = false;
let configurationDone: Promise<void> = Promise.resolve();
let pinWrite: Promise<void> = Promise.resolve();
let exitWarning: string | undefined;
let connection = '正在启动内置酒馆…', character = '待加载角色', entries = 0;
let messages: ChatMessage[] = [];
let petReplySuppressed = false;
let error: string | undefined;
let blocker: number | undefined;
let audioAbort: AbortController | undefined;
let studyRevision = 0, audioEpoch = 0;
let automaticBreakPending: { revision: number; segment: number } | null = null;
let generation: { id: string; cancelled: boolean; done: Promise<void>; finish: () => void; cancellation?: Promise<void> } | undefined;
let pendingAudio: { id: string; data: string } | null = null;
let audioWatchdog: ReturnType<typeof setTimeout> | undefined;
let snapshotWriter: SnapshotWriter | undefined;
let synthesizing = false;
let activePlayback: string | null = null;
let voiceQueue: { text: string; id: string; valid?: () => boolean }[] = [];
let foregroundMonitor: ForegroundMonitor | undefined;
let screenLocked = false;
let archive: ConversationArchive | undefined;
let viewMode: 'chat' | 'dashboard' = 'chat';
let compactBounds: Electron.Rectangle | undefined;
let dashboardBounds: Electron.Rectangle | undefined;
let archiving = false;
let companions: CompanionStore | undefined;

function state(): AppState { const archiveSave = archive?.saveStatus(); return { study: study.snapshot(), settings: publicSettings(store.value), messages, petReplySuppressed, busy, configuring, speaking, connection, tavernReady: ready, character, characterAvatar: tavern?.avatar ?? '', bookEntries: entries, foreground: foregroundMonitor?.snapshot() ?? emptyForeground(), persistence: archiveSave?.dirty ? archiveSave : snapshotWriter?.snapshot() ?? { status: 'saved', dirty: false }, view: viewMode, archive: archive?.summary() ?? { revision: 0, taskCount: 0 }, exitWarning, error }; }
function broadcast() {
  if (!store) return;
  for (const window of [chatWindow, petWindow]) if (window && !window.isDestroyed()) window.webContents.send('friend:state', state());
}
function notice(text: string) { petReplySuppressed = false; messages.push({ id: randomUUID(), role: 'notice', text, createdAt: Date.now() }); broadcast(); }
function syncWindowObservation() {
  foregroundMonitor?.setActive(store.value.windowObservationEnabled && study.snapshot().mode === 'study' && !screenLocked,
    !store.value.windowObservationEnabled ? 'disabled' : screenLocked ? 'locked' : 'inactive');
}
function keepAwake() {
  const enabled = store.value.keepAwake && study.snapshot().mode !== 'idle';
  if (enabled && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!enabled && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
function stopAudio() {
  audioEpoch++;
  voiceQueue = []; activePlayback = null;
  audioAbort?.abort(); audioAbort = undefined; pendingAudio = null; speaking = false;
  if (audioWatchdog) clearTimeout(audioWatchdog);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('friend:audio', null); broadcast();
}
function playSpeech(text: string, id: string, valid?: () => boolean) {
  if (quitting || !store.value.ttsEnabled || !store.value.mimoKey || (valid && !valid())) return;
  const speech = extractSpeech(text);
  if (!speech) return;
  voiceQueue.push({ text: speech, id, valid });
  void pumpVoice();
}
async function pumpVoice() {
  if (quitting || synthesizing || activePlayback || !voiceQueue.length) return;
  const job = voiceQueue.shift()!;
  if (!store.value.ttsEnabled || !store.value.mimoKey || (job.valid && !job.valid())) { void pumpVoice(); return; }
  synthesizing = true;
  const controller = new AbortController(); audioAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const audio = await synthesize(store.value, job.text, controller.signal);
    if (quitting || controller.signal.aborted || !store.value.ttsEnabled || (job.valid && !job.valid())) return;
    activePlayback = job.id;
    pendingAudio = { id: job.id, data: audio };
    chatWindow.webContents.send('friend:audio', pendingAudio);
    // Prevent a failed renderer from leaving the pet in the speaking state indefinitely.
    audioWatchdog = setTimeout(stopAudio, 10 * 60_000);
  } catch { if (!controller.signal.aborted) notice('语音合成失败，文字回复已保留。请检查 MiMo 设置。'); }
  finally { clearTimeout(timeout); synthesizing = false; if (!activePlayback) void pumpVoice(); }
}
async function persist(timeoutMs = 5000): Promise<boolean> {
  const snapshot = study.snapshot(), segmentId = archive?.summary().activeSegmentId;
  const serialized = JSON.stringify({ study: snapshot, messages, archiveSegmentId: segmentId, petReplySuppressed, petReplyChat: archive?.snapshot().currentChat ?? null }, null, 2);
  const [sessionSaved, archiveSaved] = await Promise.all([
    snapshotWriter ? snapshotWriter.save(serialized, timeoutMs) : true,
    archive ? withDeadline(archive.update(snapshot, segmentId), timeoutMs, '聊天归档保存超时').then(() => true, () => false) : true,
  ]);
  const saved = sessionSaved && archiveSaved;
  if (saved && !configuring && exitWarning) { exitWarning = undefined; broadcast(); }
  return saved;
}
function beginConfiguration() {
  configuring = true;
  let finish!: () => void;
  configurationDone = new Promise<void>(resolve => { finish = resolve; });
  return () => { configuring = false; finish(); if (!snapshotWriter?.snapshot().dirty && !archive?.saveStatus().dirty) exitWarning = undefined; broadcast(); drainBreakOpening(); };
}
async function configure(switching?: { previousHasMessages: boolean }) {
  ready = false;
  const result = await tavern.call('configure', { userName: store.value.userName, url: proxy.url, token: proxy.token, model: store.value.deepseekModel, avatar: tavern.avatar });
  character = result.character; entries = result.entries;
  if (result.chat) result.chat.characterName = result.character;
  if (archive) {
    if (switching) await archive.switchCharacter(result.chat, switching.previousHasMessages, study.snapshot());
    else await archive.initialize(result.chat, result.messages, study.snapshot());
    const current = archive.snapshot().currentChat;
    if (current && (current.avatar !== result.chat.avatar || current.fileName !== result.chat.fileName)) {
      const selected = await tavern.call('openConversation', { chat: current }); result.messages = selected.messages;
    }
  }
  if (switching) { messages = []; petReplySuppressed = false; }
  // Configuration and generation share admission; never replace a live message.
  replaceHistory(result.messages);
  ready = true;
  error = undefined;
  connection = store.value.deepseekKey ? '酒馆已就绪 · DeepSeek 已配置' : '酒馆已就绪 · 请配置 API';
  broadcast();
}
function replaceHistory(history: ChatMessage[]) {
  messages = mergeChatHistory(archive ? archive.visible(history) : history, messages);
}
async function changeMessage(change: MessageChange) {
  if (!change || !['edit', 'delete', 'regenerate'].includes(change.action) || typeof change.id !== 'string' || typeof change.expectedText !== 'string') throw new Error('聊天操作格式不正确');
  if (quitting || busy || configuring || !ready) throw new Error('请等待当前操作完成后再修改记录');
  const target = messages.find(message => message.id === change.id && message.role !== 'notice');
  if (!target || !target.id.startsWith('st-') || target.pending || target.text !== change.expectedText) throw new Error('聊天记录已变化，请重新选择消息');
  if (change.action === 'regenerate') {
    if (messages.filter(message => message.role !== 'notice').at(-1) !== target || target.role !== 'assistant') throw new Error('只能重新生成最新一条角色回复');
    await generate('', false, change); return;
  }
  if (change.action === 'edit' && (typeof change.text !== 'string' || !change.text.trim() || change.text.length > 20_000)) throw new Error('消息应为 1–20000 个字符');
  const finish = beginConfiguration(); stopAudio(); broadcast();
  try {
    const result = await tavern.call('changeMessage', change);
    // Deleting the displayed reply clears the pet bubble; old history is never a replacement reply.
    if (change.action === 'delete' && messages.findLast(message => message.role === 'assistant' || message.role === 'notice')?.id === change.id) petReplySuppressed = true;
    replaceHistory(result.messages); error = undefined;
    await persist();
  } finally { finish(); }
}
async function generate(text: string, automatic = false, regeneration?: MessageChange) {
  if (quitting) throw new Error('程序正在退出');
  if (configuring) throw new Error('正在保存设置或启动对话服务，请稍候');
  if (!ready) throw new Error('内置酒馆仍在启动，请稍候');
  if (busy) throw new Error('请等待当前回复完成');
  if (!store.value.deepseekKey) throw new Error('请先在设置中填写 DeepSeek API 密钥');
  if (regeneration) stopAudio();
  const id = randomUUID();
  const snapshot = study.snapshot();
  const revision = studyRevision, epoch = audioEpoch;
  let finish!: () => void;
  const job = { id, cancelled: false, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
  generation = job;
  const valid = () => !quitting && !job.cancelled && revision === studyRevision && epoch === audioEpoch;
  const previous = regeneration ? messages.find(message => message.id === regeneration.id) : undefined;
  const previousSuppression = petReplySuppressed;
  if (!automatic && !regeneration) messages.push({ id: randomUUID(), role: 'user', text });
  const message: ChatMessage = { id, role: 'assistant', text: '', pending: true };
  if (previous) messages.splice(messages.indexOf(previous), 1, message); else messages.push(message);
  petReplySuppressed = false;
  busy = true; error = undefined; broadcast();
  try {
    const result = await tavern.call('generate', { id, text, study: snapshot, automatic, regeneration, companion: companionPrompt(companions?.get(tavern.avatar) ?? defaultPreferences, snapshot.mode) });
    if (job.cancelled || quitting) throw new Error('生成已取消');
    message.text = result.text; message.pending = false;
    if (result.messages) replaceHistory(result.messages);
    const reminder = !automatic && !regeneration && study.completeRound(snapshot.segment);
    broadcast();
    playSpeech(message.text, id, valid);
    if (reminder) {
      const text = '已经聊了 30 轮啦，先回到学习，休息时我们再继续。'; notice(text);
      playSpeech(`“${text}”`, randomUUID(), () => valid() && study.snapshot().mode === 'study' && study.snapshot().segment === snapshot.segment);
    }
  } catch (cause) {
    if (previous) {
      const index = messages.indexOf(message);
      if (index >= 0) messages.splice(index, 1, previous);
      petReplySuppressed = previousSuppression;
      if (!job.cancelled && !quitting) error = '重新生成未完成，已保留原回复';
      if (/恢复尚未保存|聊天记录保存失败|会话已变化|已切换会话/.test(String(cause))) {
        tavern.close(); ready = false; connection = '对话记录需要恢复，请重启对话服务';
        error = connection;
      }
      return;
    }
    message.pending = false; message.cancelled = job.cancelled || quitting; message.failed = !message.cancelled;
    if (!message.text) message.text = message.cancelled ? '这条回复已停止。' : '这次回复没有完成。检查 API 地址、模型、密钥与网络后再试。';
    if (!message.cancelled) error = '对话生成失败';
  } finally {
    if (generation === job) generation = undefined;
    busy = false; job.finish(); broadcast(); drainBreakOpening(); await persist();
  }
}
function drainBreakOpening() {
  const token = automaticBreakPending, snapshot = study.snapshot();
  if (!token || quitting) return;
  if (token.revision !== studyRevision || token.segment !== snapshot.segment || snapshot.mode !== 'break') { automaticBreakPending = null; return; }
  if (!ready || busy || configuring || !store.value.deepseekKey) return;
  automaticBreakPending = null; // Claim once, synchronously, before any await.
  void generate('', true).catch(() => {});
}
async function cancelGeneration() {
  const job = generation;
  if (!job) return;
  if (job.cancellation) return job.cancellation;
  job.cancelled = true; stopAudio(); proxy?.abortAll();
  job.cancellation = (async () => {
    await tavern.stopGeneration();
    await withDeadline(job.done, 3500, '取消生成未完成', { onTimeout: () => {
      tavern.close(); ready = false; connection = '对话服务已停止，请重启对话服务'; broadcast();
    } });
  })().catch(() => {});
  return job.cancellation;
}
async function control(action: string, topic?: string) {
  if (quitting) throw new Error('程序正在退出');
  if (configuring) throw new Error('正在处理设置，请稍候');
  if (archiving) throw new Error('正在保存本段聊天，请稍候');
  if (archive && ['start', 'end', 'finish'].includes(action)) { await archiveControl(action, topic); return; }
  let changed = false;
  if (action === 'start') changed = study.start(topic);
  else if (action === 'pause') changed = study.pause();
  else if (action === 'resume') changed = study.resume();
  else if (action === 'end') changed = study.end();
  else if (action === 'finish') { if (study.snapshot().mode !== 'idle') { study.finish(); changed = true; } }
  else throw new Error('未知学习控制');
  if (!changed) return;
  studyRevision++; automaticBreakPending = null; stopAudio(); void cancelGeneration();
  keepAwake(); syncWindowObservation(); broadcast();
  if (action === 'start') notice(`开始本段学习：${study.snapshot().topic}`);
  if (action === 'pause') notice('学习已暂停');
  if (action === 'resume') notice('继续学习');
  if (action === 'finish') notice('任务已结束');
  if (action === 'end') {
    notice('本段学习结束，进入休息。下一段由你主动开始。');
    automaticBreakPending = { revision: studyRevision, segment: study.snapshot().segment };
    drainBreakOpening();
  }
  // All control effects above are synchronous and versioned. Disk completion
  // cannot perform a stale start/opening after a subsequent control transition.
  await persist();
}
async function archiveControl(action: string, topic?: string) {
  const before = study.snapshot();
  if (action === 'start' && ['study', 'paused'].includes(before.mode)) return;
  if (action === 'end' && !['study', 'paused'].includes(before.mode)) return;
  if (action === 'finish' && before.mode === 'idle') return;
  if (configuring || !ready) throw new Error('请等待对话服务就绪后重试，当前聊天仍保留');
  const finish = beginConfiguration();
  archiving = true;
  study.pause(); studyRevision++; automaticBreakPending = null; stopAudio();
  let committed = false;
  let planned = study.snapshot();
  try {
    await cancelGeneration();
    const conversation = await tavern.call('getConversation');
    const candidate = new StudySession(); candidate.restore(study.snapshot());
    if (action === 'start') candidate.start(topic);
    else if (action === 'end') candidate.end();
    else candidate.finish();
    planned = candidate.snapshot();
    if (action === 'end') {
      await archive!.endSegment(planned, conversation.messages.map((message: ChatMessage) => message.id));
      committed = true; study.end(); messages = []; petReplySuppressed = false;
      automaticBreakPending = { revision: studyRevision, segment: study.snapshot().segment };
    } else {
      const chat = action === 'start'
        ? await archive!.startSegment(planned.topic, planned, conversation.chat, conversation.messages.length > 0)
        : await archive!.finishTask(planned, study.snapshot().elapsedMs, conversation.chat);
      committed = true;
      petReplySuppressed = false;
      if (action === 'finish') { study.finish(); messages = []; petReplySuppressed = false; broadcast(); }
      const opened = await tavern.call('openConversation', { chat });
      messages = archive!.visible(opened.messages);
      petReplySuppressed = false;
      if (action === 'start') { study.start(topic); notice(`开始本段学习：${study.snapshot().topic}`); }
    }
    error = undefined; keepAwake(); syncWindowObservation(); broadcast(); await persist();
  } catch (cause) {
    if (committed) {
      study.restore(planned); messages = []; tavern.close(); ready = false;
      connection = '记录已保存，请重启对话服务恢复当前会话';
      error = connection;
    } else { error = '聊天尚未归档，学习已暂停，原聊天仍保留。请重试结束操作。'; }
    keepAwake(); syncWindowObservation(); broadcast(); throw new Error(error || String(cause));
  } finally { archiving = false; finish(); }
}
async function saveSettings(patch: Partial<Settings>) {
  if (quitting || busy || configuring) throw new Error('对话或设置操作尚未完成，请稍后再保存设置');
  const finishConfiguration = beginConfiguration(); stopAudio(); broadcast();
  try {
    await store.save(patch);
    if (quitting) return;
    if ('chatAlwaysOnTop' in patch) chatWindow.setAlwaysOnTop(store.value.chatAlwaysOnTop, 'pop-up-menu');
    if ('petScale' in patch) resizePet();
    keepAwake(); syncWindowObservation(); if (ready) await configure();
  } catch (cause) {
    if (!ready) connection = '对话配置未完成，请重启对话服务';
    throw cause;
  } finally { finishConfiguration(); }
}
function characterAdmission() {
  if (quitting || busy || configuring) throw new Error('请等待当前对话或设置操作完成');
  if (!tavern?.window || tavern.window.isDestroyed()) throw new Error('酒馆尚未就绪，请重启对话服务后重试');
}
function editorAdmission() {
  characterAdmission();
  if (study.snapshot().mode !== 'idle') throw new Error('请先结束当前学习任务，再保存角色或陪伴偏好');
}
function avatarArgument(avatar: unknown): asserts avatar is string {
  if (!validAvatar(avatar)) throw new Error('角色标识不正确');
}
async function characterDocument(avatar: string): Promise<CharacterDocument> {
  avatarArgument(avatar);
  const { data, world } = await tavern.call('getDefinition', { avatar });
  if (!data || typeof data.name !== 'string') throw new Error('角色数据无法读取');
  const preferences = companions?.get(avatar) ?? { ...defaultPreferences };
  const fields = fieldsFromData(data);
  return { avatar, revision: revisionOf(fields), fields,
    ...loreDocument(data, world),
    linkedWorld: typeof data.extensions?.world === 'string' ? data.extensions.world : '', preferences, preferenceRevision: revisionOf(preferences) };
}
async function deleteLore(avatar: unknown, revision: unknown, key: unknown): Promise<CharacterDocument> {
  editorAdmission(); avatarArgument(avatar);
  if (typeof revision !== 'string' || typeof key !== 'string' || key.length > 300) throw new Error('角色书删除格式不正确');
  const finish = beginConfiguration(); stopAudio(); broadcast();
  try {
    const original = await tavern.call('getDefinition', { avatar });
    if (loreDocument(original.data, original.world).loreRevision !== revision) throw new Error('角色书已变化，请重新读取后再删除');
    const change = removeLore(original.data, original.world, key);
    const backupDirectory = path.join(app.getPath('userData'), 'character-backups');
    await mkdir(backupDirectory, { recursive: true });
    await copyFile(path.join(app.getPath('userData'), 'tavern-data/default-user/characters', avatar), path.join(backupDirectory, `${Date.now()}-${randomUUID()}.png`));
    await tavern.call('editLore', { avatar, expectedData: JSON.stringify(original.data), expectedWorld: original.world ?? null, ...change, worldName: change.worldCopy ? `Friend-book-${randomUUID()}` : undefined });
    const result = await characterDocument(avatar);
    if (ready && avatar === tavern.avatar) {
      try { await configure(); await persist(); }
      catch { ready = false; connection = '条目已删除，请重启对话服务应用修改'; error = connection; result.warning = connection; }
    }
    return result;
  } finally { finish(); }
}
async function deleteRecord(taskId: unknown, segmentId?: unknown) {
  characterAdmission();
  if (!archive || typeof taskId !== 'string' || (segmentId !== undefined && typeof segmentId !== 'string')) throw new Error('记录标识不正确');
  const finish = beginConfiguration(); broadcast();
  const transaction = new ChatDeletion(app.getPath('userData'));
  try {
    const plan = archive.deletionPlan(taskId, segmentId);
    await transaction.prepare(plan.chats);
    try {
      await transaction.remove(chat => tavern.call('deleteArchivedChat', { chat }));
      await archive.deleteRecord(taskId, segmentId);
    } catch (cause) {
      try { await transaction.settle(archive.references()); }
      catch { throw new Error('删除未完成，恢复备份仍保留；请检查磁盘权限后重启恢复记录'); }
      throw cause;
    }
    // A leftover journal is safe: startup sees the committed index and does not restore deleted records.
    await transaction.settle(archive.references()).catch(() => {});
  } finally { finish(); }
}
async function saveCharacter(input: CharacterSave): Promise<CharacterDocument> {
  editorAdmission();
  if (!input || typeof input !== 'object') throw new Error('角色保存格式不正确');
  const fields = validateFields(input.fields);
  if (input.avatar !== undefined) avatarArgument(input.avatar);
  const finish = beginConfiguration(); stopAudio(); broadcast();
  try {
    if (!input.avatar) {
      const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...fields, creator: '', creator_notes: '', character_version: '1.0', tags: [], alternate_greetings: [], extensions: {} } };
      const avatar = await tavern.importCharacter(JSON.stringify(card), undefined, false);
      return await characterDocument(avatar);
    }
    const current = await tavern.call('getDefinition', { avatar: input.avatar });
    if (typeof input.revision !== 'string' || revisionOf(fieldsFromData(current.data)) !== input.revision) throw new Error('角色卡已变化，请重新读取后再保存；未保存的编辑仍保留');
    const backupDirectory = path.join(app.getPath('userData'), 'character-backups');
    await mkdir(backupDirectory, { recursive: true });
    await copyFile(path.join(app.getPath('userData'), 'tavern-data/default-user/characters', input.avatar), path.join(backupDirectory, `${Date.now()}-${randomUUID()}.png`));
    await tavern.call('editDefinition', { avatar: input.avatar, expectedData: JSON.stringify(current.data), fields });
    const result = await characterDocument(input.avatar);
    if (ready && input.avatar === tavern.avatar) {
      try { await configure(); await persist(); }
      catch { ready = false; connection = '角色已保存，请重启对话服务应用修改'; error = connection; result.warning = connection; }
    }
    return result;
  } finally { finish(); }
}
async function copyCharacter(avatar: unknown, revision: unknown): Promise<CharacterDocument> {
  editorAdmission(); avatarArgument(avatar);
  const finish = beginConfiguration(); broadcast();
  try {
    const original = await characterDocument(avatar);
    if (original.revision !== revision) throw new Error('原卡已变化，请重新读取后再另存副本');
    const copied = await tavern.call('duplicateDefinition', { avatar }); avatarArgument(copied);
    const result = await characterDocument(copied);
    const source = await tavern.call('getDefinition', { avatar: copied });
    try {
      const fields = { ...result.fields, name: `${result.fields.name.slice(0, 90)}（桌宠版）` };
      await tavern.call('editDefinition', { avatar: copied, expectedData: JSON.stringify(source.data), fields });
      if (companions) await companions.save(copied, revisionOf(companions.get(copied)), original.preferences);
      return await characterDocument(copied);
    } catch {
      const recovered = await characterDocument(copied);
      recovered.warning = '副本已创建，名称或陪伴偏好未全部复制；请在此副本中检查并保存。原卡未修改。'; return recovered;
    }
  } finally { finish(); }
}
async function newCharacterChat() {
  editorAdmission();
  if (!ready || !archive) throw new Error('请先选择并启用一个角色');
  const finish = beginConfiguration(); stopAudio(); studyRevision++; automaticBreakPending = null; broadcast();
  let committed = false;
  try {
    const previous = await tavern.call('getConversation');
    if (!(await persist())) throw new Error('旧聊天尚未保存，请重试保存');
    const next = { ...archive.newChat(tavern.avatar), characterName: character };
    await archive.switchCharacter(next, previous.messages.length > 0, study.snapshot()); committed = true; petReplySuppressed = false;
    const opened = await tavern.call('openConversation', { chat: next }); messages = opened.messages; petReplySuppressed = false;
    await persist();
  } catch (cause) {
    if (committed) { tavern.close(); ready = false; connection = '旧聊天已归档，请重启对话服务恢复新会话'; error = connection; }
    throw cause;
  } finally { finish(); }
}
async function importCharacter() {
  characterAdmission();
  const finish = beginConfiguration(); broadcast();
  try {
    const result = await dialog.showOpenDialog(chatWindow, { title: '导入角色卡', properties: ['openFile'], filters: [{ name: '角色卡（PNG / JSON）', extensions: ['png', 'json'] }] });
    if (result.canceled || !result.filePaths.length || quitting) return null;
    const file = await open(result.filePaths[0], 'r');
    let bytes: Buffer;
    try {
      if ((await file.stat()).size > maxCardBytes) throw new Error('角色卡文件过大（最多 32 MB）');
      bytes = Buffer.alloc(maxCardBytes + 1);
      let length = 0;
      while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      bytes = bytes.subarray(0, length);
    } finally { await file.close(); }
    let card;
    try { card = decodeCharacterCard(bytes, path.extname(result.filePaths[0])); }
    catch (cause) { throw new Error(cause instanceof Error && /角色|PNG|JSON|图片|请选择/.test(cause.message) ? cause.message : '角色卡数据无法解析'); }
    const avatar = await tavern.importCharacter(card.json, card.png, false);
    return { avatar, name: JSON.parse(card.json).data.name as string };
  } finally { finish(); }
}
async function selectCharacter(avatar: unknown) {
  characterAdmission();
  if (!validAvatar(avatar)) throw new Error('角色标识不正确');
  if (study.snapshot().mode !== 'idle') throw new Error('请先结束当前任务，再更换角色');
  const finish = beginConfiguration(), previousAvatar = tavern.avatar;
  const wasReady = ready;
  const previousDisplay = { character, entries, connection };
  stopAudio(); studyRevision++; automaticBreakPending = null; broadcast();
  try {
    if (!(await tavern.listCharacters()).some(item => item.avatar === avatar)) throw new Error('该角色已不存在，请刷新列表');
    if (avatar === previousAvatar && wasReady) { await configure(); await persist(); return; }
    let previous;
    if (wasReady) {
      try { previous = await tavern.call('getConversation'); }
      catch (cause) {
        if (!/酒馆已切换会话/.test(String(cause))) throw cause;
        await configure();
        previous = await tavern.call('getConversation');
      }
    }
    if (!(await persist())) throw new Error('当前聊天尚未保存，请重试保存后更换角色');
    tavern.avatar = avatar;
    await configure({ previousHasMessages: !!previous?.messages.length });
    await persist();
  } catch (cause) {
    if (tavern.avatar !== previousAvatar) {
      tavern.avatar = previousAvatar;
      try {
        if (wasReady) await configure();
        else { ready = false; character = previousDisplay.character; entries = previousDisplay.entries; connection = previousDisplay.connection; }
      }
      catch { tavern.close(); ready = false; connection = '角色切换未完成，请重启对话服务恢复'; error = connection; }
    }
    if (!ready && wasReady) { connection = '角色同步未完成，请停止酒馆中的回复后重启对话服务'; error = connection; }
    throw cause;
  } finally { finish(); }
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (event.sender !== chatWindow?.webContents && event.sender !== petWindow?.webContents) throw new Error('无效窗口');
}
function showChat() { chatWindow.show(); chatWindow.focus(); }
function resizePet() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const old = petWindow.getBounds(), work = screen.getDisplayMatching(old).workArea;
  const size = petSize(store.value.petScale, petContentHeight, work);
  petWindow.setBounds({ ...size, x: Math.round(Math.max(work.x, Math.min(old.x + (old.width - size.width) / 2, work.x + work.width - size.width))),
    y: Math.round(Math.max(work.y, Math.min(old.y + old.height - size.height, work.y + work.height - size.height))) });
}
function switchView(view: 'chat' | 'dashboard') {
  if (view === viewMode) { showChat(); return; }
  if (viewMode === 'chat') compactBounds = chatWindow.getBounds(); else dashboardBounds = chatWindow.getBounds();
  viewMode = view;
  const work = screen.getDisplayMatching(chatWindow.getBounds()).workArea;
  chatWindow.setMinimumSize(Math.min(view === 'dashboard' ? 900 : 390, work.width), Math.min(640, work.height));
  const saved = view === 'dashboard' ? dashboardBounds : compactBounds;
  const width = Math.min(saved?.width ?? (view === 'dashboard' ? 1160 : 480), work.width);
  const height = Math.min(saved?.height ?? (view === 'dashboard' ? 820 : 730), work.height);
  chatWindow.setBounds({ x: Math.round(Math.max(work.x, Math.min(saved?.x ?? work.x + (work.width - width) / 2, work.x + work.width - width))),
    y: Math.round(Math.max(work.y, Math.min(saved?.y ?? work.y + (work.height - height) / 2, work.y + work.height - height))), width, height });
  broadcast(); showChat();
}
function setupIPC() {
  ipcMain.handle('friend:lore-delete', async (event, avatar, revision, key) => { trusted(event); return deleteLore(avatar, revision, key); });
  ipcMain.handle('friend:archive-delete', async (event, taskId, segmentId) => { trusted(event); return deleteRecord(taskId, segmentId); });
  ipcMain.handle('friend:models', async (event, query) => {
    trusted(event);
    if (fetchingModels) throw new Error('正在获取模型列表，请稍候');
    fetchingModels = true;
    try { return await fetchModels(query, store.value); } finally { fetchingModels = false; }
  });
  ipcMain.on('friend:pet-layout', (event, height) => {
    if (event.sender !== petWindow?.webContents || !Number.isFinite(height) || height < 0 || height > 220) return;
    if (petContentHeight === height) return;
    petContentHeight = height; resizePet();
  });
  ipcMain.handle('friend:character-get', async (event, avatar) => {
    trusted(event); characterAdmission(); avatarArgument(avatar); const finish = beginConfiguration();
    try { return await characterDocument(avatar); } finally { finish(); }
  });
  ipcMain.handle('friend:character-save', async (event, input) => { trusted(event); return saveCharacter(input); });
  ipcMain.handle('friend:character-copy', async (event, avatar, revision) => { trusted(event); return copyCharacter(avatar, revision); });
  ipcMain.handle('friend:companion-save', async (event, avatar, revision, preferences) => {
    trusted(event); editorAdmission(); avatarArgument(avatar); const value = validatePreferences(preferences);
    if (!companions || typeof revision !== 'string') throw new Error('陪伴偏好尚未就绪');
    const finish = beginConfiguration(); stopAudio(); broadcast();
    try { await characterDocument(avatar); await companions.save(avatar, revision, value); return await characterDocument(avatar); } finally { finish(); }
  });
  ipcMain.handle('friend:character-chat', async event => { trusted(event); await newCharacterChat(); });
  ipcMain.handle('friend:characters', async event => {
    trusted(event); characterAdmission(); const finish = beginConfiguration();
    try { return await tavern.listCharacters(); } finally { finish(); }
  });
  ipcMain.handle('friend:character-import', async event => { trusted(event); return importCharacter(); });
  ipcMain.handle('friend:character-select', async (event, avatar) => { trusted(event); await selectCharacter(avatar); });
  ipcMain.handle('friend:get', event => { trusted(event); return state(); });
  ipcMain.handle('friend:send', async (event, text: unknown) => {
    trusted(event);
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new Error('消息应为 1–20000 个字符');
    const command = explicitCommand(text);
    if (command) { await control(command); return; }
    if (text.trimStart().startsWith('/')) throw new Error('聊天小窗不执行酒馆脚本命令；请使用普通文字');
    await generate(text);
  });
  ipcMain.handle('friend:control', async (event, action, topic) => { trusted(event); if (typeof topic !== 'undefined' && (typeof topic !== 'string' || topic.length > 200)) throw new Error('学习主题过长'); await control(action, topic); });
  ipcMain.handle('friend:settings', async (event, patch: Partial<Settings>) => {
    trusted(event); await saveSettings(patch);
  });
  ipcMain.handle('friend:pin', async (event, pinned: unknown) => {
    trusted(event);
    if (quitting || typeof pinned !== 'boolean') throw new Error('置顶状态不正确');
    const write = store.save({ chatAlwaysOnTop: pinned });
    pinWrite = write.catch(() => {});
    await write;
    // On Windows 10, floating's behind-taskbar reorder can demote this window.
    // pop-up-menu keeps the native topmost flag through repeated pin/unpin.
    if (!quitting) { chatWindow.setAlwaysOnTop(store.value.chatAlwaysOnTop, 'pop-up-menu'); broadcast(); }
  });
  ipcMain.handle('friend:message', async (event, change: MessageChange) => { trusted(event); await changeMessage(change); });
  ipcMain.handle('friend:archive-list', event => { trusted(event); return archive?.list() ?? []; });
  ipcMain.handle('friend:archive-task', (event, id) => { trusted(event); if (typeof id !== 'string' || !archive) throw new Error('任务不存在'); return archive.getTask(id); });
  ipcMain.handle('friend:archive-segment', (event, taskId, segmentId) => { trusted(event); if (typeof taskId !== 'string' || typeof segmentId !== 'string' || !archive) throw new Error('学习段不存在'); return archive.getSegment(taskId, segmentId); });
  ipcMain.handle('friend:action', async (event, action) => {
    trusted(event);
    if (action === 'hide') chatWindow.hide();
    if (action === 'settings') { chatWindow.webContents.send('friend:open-settings', chatWindow.isVisible()); }
    if (action === 'chat') switchView('chat');
    if (action === 'dashboard') switchView('dashboard');
    if (action === 'compact') switchView('chat');
    if (action === 'quit') app.quit();
    if (action === 'tavern') { if (ready) tavern.show(); }
    if (action === 'stop-audio') stopAudio();
    if (action === 'stop-generation') await cancelGeneration();
    if (action === 'restart-tavern') await startTavern();
    if (action === 'retry-save') await persist();
    if (action === 'force-quit' && (exitWarning || snapshotWriter?.snapshot().dirty || archive?.saveStatus().dirty)) {
      allowQuit = true; quitting = true; automaticBreakPending = null;
      stopAudio(); snapshotWriter?.close(); foregroundMonitor?.stop(); tavern?.close(); proxy?.close(); app.quit();
    }
  });
  ipcMain.on('friend:move', (event, x, y) => {
    if (event.sender !== petWindow.webContents || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
    const size = petSize(store.value.petScale, petContentHeight, display);
    petWindow.setBounds({ ...size, x: Math.round(Math.max(display.x, Math.min(x, display.x + display.width - size.width))),
      y: Math.round(Math.max(display.y, Math.min(y, display.y + display.height - size.height))) });
  });
  ipcMain.on('friend:audio-status', (event, id, playing) => {
    if (event.sender !== chatWindow.webContents || typeof playing !== 'boolean' || id !== activePlayback) return;
    speaking = playing;
    if (!playing) { pendingAudio = null; activePlayback = null; if (audioWatchdog) clearTimeout(audioWatchdog); void pumpVoice(); }
    broadcast();
  });
  ipcMain.on('tavern:event', (event, data) => {
    if (event.sender !== tavern?.window?.webContents || !data || typeof data.type !== 'string') return;
    if (data.type === 'stream') {
      const message = generation && !generation.cancelled && !quitting && generation.id === data.id && messages.find(m => m.id === data.id && m.pending);
      if (message && typeof data.text === 'string') { message.text = data.text; broadcast(); }
    }
  });
}
async function startTavern() {
  if (!proxy || quitting || busy || configuring) throw new Error('当前操作尚未完成，请稍后重启对话服务');
  const finishConfiguration = beginConfiguration(); ready = false; stopAudio(); connection = '正在启动内置酒馆…'; broadcast();
  try {
    if (tavern) await tavern.closeAndWait();
    if (quitting) return;
    const instance = new TavernRuntime(root, app.getPath('userData'), () => {
      if (tavern !== instance) return;
      proxy?.abortAll(); ready = false; connection = '酒馆服务已停止，可重启对话服务'; broadcast();
    });
    tavern = instance;
    await instance.start();
    if (quitting) { instance.close(); return; }
    const available = await instance.listCharacters();
    const selected = archive?.snapshot().currentChat?.avatar;
    if (selected) {
      if (!available.some(item => item.avatar === selected)) { connection = '已选角色不存在，请在陪伴设置中选择其他角色'; error = connection; return; }
      instance.avatar = selected;
    } else {
      let bundled: string | undefined;
      try { bundled = await readFile(path.join(root, 'assets/characters/主人的猫.json'), 'utf8'); }
      catch (cause: any) { if (cause.code !== 'ENOENT') throw cause; }
      if (bundled) instance.avatar = await instance.importCharacter(decodeCharacterCard(Buffer.from(bundled), '.json').json);
      else if (available.length) instance.avatar = available[0].avatar;
      else { character = '尚未选择角色'; connection = '请在陪伴设置中导入 PNG/JSON 角色卡'; error = undefined; return; }
    }
    if (quitting) { instance.close(); return; }
    await configure();
  } catch {
    tavern?.close(); ready = false; connection = '酒馆启动失败，可重启对话服务'; error = connection;
  } finally { finishConfiguration(); }
}
async function shutdown() {
  quitting = true; automaticBreakPending = null; studyRevision++; stopAudio();
  await cancelGeneration();
  foregroundMonitor?.stop();
  if (blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
  const configured = await withDeadline(Promise.all([configurationDone, pinWrite, archive?.flush()]), 1500, '设置操作尚未完成').then(() => true, () => false);
  const saved = await persist(1500);
  if (!saved || !configured) {
    quitting = false; keepAwake(); syncWindowObservation();
    exitWarning = configured ? '退出前未能保存，已取消退出。仍然退出会丢失未保存的进度。' : '设置操作尚未完成，已取消退出。仍然退出可能丢失未保存的设置。';
    notice(exitWarning); switchView('chat'); return;
  }
  snapshotWriter?.close(); tavern?.close(); proxy?.close(); allowQuit = true; app.quit();
}

app.on('second-instance', () => chatWindow && showChat());
app.on('window-all-closed', () => { /* Tray owns the application lifecycle. */ });
app.on('before-quit', event => {
  if (allowQuit) return;
  event.preventDefault(); if (!quitting) void shutdown();
});
app.whenReady().then(async () => {
  store = new SettingsStore(app.getPath('userData'));
  await store.load(); await mkdir(app.getPath('userData'), { recursive: true });
  companions = new CompanionStore(app.getPath('userData')); await companions.load();
  snapshotWriter = new SnapshotWriter(path.join(app.getPath('userData'), 'session.json'), broadcast);
  let savedSession: any;
  try { savedSession = JSON.parse(await readFile(path.join(app.getPath('userData'), 'session.json'), 'utf8')); study.restore(savedSession.study); } catch {}
  archive = new ConversationArchive(app.getPath('userData'), broadcast); await archive.load();
  await ChatDeletion.recover(app.getPath('userData'), archive.references());
  const library = archive.snapshot();
  petReplySuppressed = savedSession?.petReplySuppressed === true && !!library.currentChat && savedSession.petReplyChat?.avatar === library.currentChat.avatar && savedSession.petReplyChat?.fileName === library.currentChat.fileName;
  const phase = (mode?: string) => mode === 'study' || mode === 'paused' ? 'learning' : mode;
  if (library.study && (!savedSession || savedSession.archiveSegmentId !== library.activeSegmentId || savedSession.study.segment !== library.study.segment || phase(savedSession.study.mode) !== phase(library.study.mode))) study.restore(library.study);
  if (testing) await store.save({ deepseekUrl: process.env.FRIEND_TEST_URL!, deepseekKey: 'test-key', mimoUrl: process.env.FRIEND_TEST_URL!, mimoKey: 'test-tts', voiceStyle: '', deepseekModel: 'mock-study', keepAwake: false });
  const readerPath = app.isPackaged ? path.join(process.resourcesPath, 'native/foreground-reader.exe') : path.join(root, 'dist/native/foreground-reader.exe');
  foregroundMonitor = new ForegroundMonitor(readerPath, broadcast);
  chatWindow = new BrowserWindow({ width: 480, height: 730, minWidth: 390, minHeight: 640, show: testing, frame: false, backgroundColor: '#f8f6f1', title: 'Friend · 狐狸聊天',
    webPreferences: { preload: path.join(root, 'dist/preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  chatWindow.setAlwaysOnTop(store.value.chatAlwaysOnTop, 'pop-up-menu');
  const area = screen.getPrimaryDisplay().workArea;
  const initialPetSize = petSize(store.value.petScale, 0, area);
  petWindow = new BrowserWindow({ ...initialPetSize, x: Math.max(area.x, area.x + area.width - initialPetSize.width - 24), y: Math.max(area.y, area.y + area.height - initialPetSize.height - 24), show: true, frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(root, 'dist/preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.on('resize', () => {
    if (!quitting && petWindow.getSize()[0] !== petWidth(store.value.petScale)) resizePet();
  });
  for (const window of [petWindow, chatWindow]) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  }
  setupIPC();
  await chatWindow.loadFile(path.join(root, 'dist/index.html'));
  await petWindow.loadFile(path.join(root, 'dist/pet.html'));
  // Reapply after the native window has finished its initial load/show transition.
  petWindow.setAlwaysOnTop(true, 'floating');
  chatWindow.setAlwaysOnTop(store.value.chatAlwaysOnTop, 'pop-up-menu');
  tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets/pets/wanxiang-fox/sprites/sit.png')).resize({ width: 24, height: 28 }));
  tray.setToolTip('Friend 学习桌宠');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开聊天', click: () => switchView('chat') }, { label: '学习中心', click: () => switchView('dashboard') }, { label: '显示狐狸', click: () => petWindow.show() }, { label: '角色与世界书', click: () => ready && tavern.show() }, { type: 'separator' }, { label: '退出 Friend', click: () => app.quit() }]));
  tray.on('double-click', () => switchView('chat'));
  powerMonitor.on('suspend', () => { if (study.pause(true)) { studyRevision++; stopAudio(); void cancelGeneration(); notice('系统睡眠，学习计时已暂停'); void persist(); } syncWindowObservation(); });
  powerMonitor.on('resume', () => { if (!quitting && study.resume(true)) { studyRevision++; notice('系统恢复，已自动继续学习'); void persist(); } syncWindowObservation(); });
  powerMonitor.on('lock-screen', () => { screenLocked = true; syncWindowObservation(); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; syncWindowObservation(); });
  // Locking the screen deliberately does not pause paper study.
  setInterval(broadcast, 1000).unref();
  setInterval(() => { if (!quitting) void persist(); }, 15_000).unref();
  keepAwake();
  proxy = await startModelProxy(() => store.value);
  await startTavern();
}).catch(e => { console.error('Friend startup error:', e instanceof Error ? e.message : 'unknown'); app.quit(); });
