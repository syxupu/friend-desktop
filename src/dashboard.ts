import type { AppState, TaskSummary, ArchivedTask, SegmentHistory } from './types';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let current: AppState;
let tab: 'history' | 'settings' = 'history';
let tasks: TaskSummary[] = [], selectedTask = '', selectedSegment = '';
let detail: ArchivedTask | undefined, conversation: SegmentHistory | undefined;
let revision = -1, listRequest = 0, selectionRequest = 0;
let openRequest = 0, opening = false;
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const duration = (value: number) => { const seconds = Math.floor(value / 1000); return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分${seconds % 60}秒`; };
const empty = (text: string) => { const p = document.createElement('p'); p.className = 'record-empty'; p.textContent = text; return p; };
function failure(cause: unknown) { el('history-error').textContent = `记录读取失败：${String(cause).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')}`; el('history-error').hidden = false; }
function renderTasks() {
  const query = el<HTMLInputElement>('task-search').value.trim().toLowerCase();
  const filtered = tasks.filter(task => `${task.title} ${date(task.startedAt)} ${new Date(task.startedAt).toLocaleDateString('sv-SE')}`.toLowerCase().includes(query));
  el('archive-count').textContent = `共 ${tasks.length} 次记录 · 按任务和学习段保存`;
  el('task-list').replaceChildren(...(filtered.length ? filtered.map(task => {
    const button = document.createElement('button'); button.className = `task-entry${task.id === selectedTask ? ' selected' : ''}`; button.dataset.taskId = task.id;
    const title = document.createElement('strong'); title.textContent = task.title;
    const meta = document.createElement('span'); meta.textContent = `${task.kind === 'legacy' ? '旧记录 · 收录于 ' : ''}${date(task.startedAt)}`;
    const count = document.createElement('small'); count.textContent = `${task.segmentCount} 段 · ${duration(task.durationMs)} · ${task.endedAt ? '已结束' : '进行中'}`;
    button.append(title, meta, count); button.onclick = () => void selectTask(task.id); return button;
  }) : [empty(query ? '没有匹配的任务' : '开始一次学习，记录就会出现在这里。')]));
}
function renderSegments() {
  if (!detail) return;
  el('task-details').replaceChildren();
  const title = document.createElement('h2'); title.textContent = detail.title;
  const summary = document.createElement('p'); summary.textContent = `${date(detail.startedAt)}${detail.endedAt ? ` — ${date(detail.endedAt)}` : ' · 进行中'}`;
  el('task-details').append(title, summary);
  if (detail.imported || detail.kind === 'legacy') { const hint = document.createElement('p'); hint.textContent = '升级前的聊天未分段，已按原会话保留。收录时间为升级时间。'; el('task-details').append(hint); }
  el('segment-list').replaceChildren(...detail.segments.map(segment => {
    const button = document.createElement('button'); button.className = `segment-entry${segment.id === selectedSegment ? ' selected' : ''}`; button.dataset.segmentId = segment.id;
    const title = document.createElement('strong'); title.textContent = `第 ${segment.number} 段 · ${segment.topic || '自主学习'}`;
    const meta = document.createElement('span'); meta.textContent = `${duration(segment.durationMs)} · ${segment.endedAt ? '已结束' : '学习中'}`;
    const started = document.createElement('small'); started.textContent = date(segment.startedAt);
    button.append(title, meta, started); button.onclick = () => void selectSegment(detail!.id, segment.id); return button;
  }));
}
function renderConversation() {
  if (!conversation) return;
  const { segment, messages } = conversation;
  el('record-title').textContent = `第 ${segment.number} 段 · ${segment.topic || '聊天记录'}`;
  el('record-meta').textContent = `${duration(segment.durationMs)}学习 · ${messages.length} 条消息 · 只读浏览，包含本段后的休息聊天`;
  const query = el<HTMLInputElement>('record-search').value.trim().toLowerCase();
  const filtered = messages.filter(message => message.text.toLowerCase().includes(query));
  el('record-messages').replaceChildren(...(filtered.length ? filtered.map(message => {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    const label = document.createElement('span'); label.className = 'message-label';
    label.textContent = `${message.role === 'user' ? current.settings.userName : current.character}${message.createdAt ? ` · ${date(message.createdAt)}` : ''}${segment.endedAt && message.createdAt && message.createdAt >= segment.endedAt ? ' · 休息交流' : ''}`;
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.text;
    article.append(label, bubble); return article;
  }) : [empty(query ? '本段没有匹配的消息' : '这段还没有聊天消息。')]));
}
async function selectTask(id: string) {
  const request = ++selectionRequest; selectedTask = id; selectedSegment = ''; conversation = undefined;
  el('record-messages').replaceChildren(empty('选择本任务下的学习段')); renderTasks();
  try {
    const task = await window.friend.getTask(id); if (request !== selectionRequest) return;
    detail = task; renderSegments();
    if (task.segments.length) await selectSegment(id, task.segments[0].id);
  } catch (cause) { if (request === selectionRequest) failure(cause); }
}
async function selectSegment(taskId: string, id: string) {
  const same = conversation?.taskId === taskId && conversation?.segment.id === id;
  const scroll = same ? el('record-messages').scrollTop : 0;
  if (!same) el<HTMLInputElement>('record-search').value = '';
  const request = ++selectionRequest; selectedSegment = id; renderSegments();
  el('history-error').hidden = true; el('record-messages').replaceChildren(empty('正在读取这段聊天…'));
  try {
    const result = await window.friend.getSegment(taskId, id);
    if (request !== selectionRequest || selectedTask !== taskId || selectedSegment !== id) return;
    conversation = result; renderConversation(); el('record-messages').scrollTop = scroll;
  } catch (cause) { if (request === selectionRequest) failure(cause); }
}
async function refresh() {
  const request = ++listRequest;
  try {
    const result = await window.friend.listTasks(); if (request !== listRequest) return;
    tasks = result; renderTasks();
    if (!selectedTask && tasks.length) await selectTask(tasks[0].id);
    else if (selectedTask) {
      const selection = selectionRequest, id = selectedTask;
      const updated = await window.friend.getTask(id);
      if (selection !== selectionRequest || id !== selectedTask) return;
      detail = updated; renderSegments();
      if (selectedSegment) await selectSegment(id, selectedSegment);
    }
  } catch (cause) { if (request === listRequest) failure(cause); }
}
export async function openWorkspace(page: 'history' | 'settings' = 'history') {
  const request = ++openRequest; opening = true;
  tab = page;
  try {
    await window.friend.action('dashboard');
    const state = await window.friend.getState(); if (request !== openRequest) return;
    revision = state.archive.revision; renderDashboard(state);
    if (page === 'settings') document.dispatchEvent(new Event('friend:open-settings'));
    else { el<HTMLDialogElement>('settings').close(); await refresh(); }
  } finally { if (request === openRequest) opening = false; }
}
export function renderDashboard(state: AppState) {
  current = state;
  const expanded = state.view === 'dashboard';
  document.body.classList.toggle('dashboard-mode', expanded);
  el('chat-content').hidden = expanded; el('dashboard').hidden = !expanded;
  if (!expanded) el<HTMLDialogElement>('settings').close();
  el('workspace-button').title = expanded ? '返回聊天小窗' : '打开学习中心';
  el('workspace-button').setAttribute('aria-label', expanded ? '返回聊天小窗' : '打开学习中心');
  el('workspace-button').textContent = expanded ? '小窗' : '▣';
  el('history-page').hidden = tab !== 'history'; el('settings-page').hidden = tab !== 'settings';
  el('nav-history').classList.toggle('nav-selected', tab === 'history'); el('nav-settings').classList.toggle('nav-selected', tab === 'settings');
  el('dashboard-mode').textContent = { idle: '等待开始', study: '专注学习', paused: '已暂停', break: '休息一下' }[state.study.mode];
  el('dashboard-timer').textContent = duration(state.study.elapsedMs); el('dashboard-topic').textContent = state.study.topic || '尚未开始学习';
  if (expanded && tab === 'history' && !opening && revision !== state.archive.revision) { revision = state.archive.revision; void refresh(); }
}
el('workspace-button').onclick = () => { if (current?.view === 'dashboard') void window.friend.action('compact'); else void openWorkspace().catch(failure); };
el('back-to-chat').onclick = () => void window.friend.action('compact');
el('nav-history').onclick = () => void openWorkspace('history').catch(failure);
el('nav-settings').onclick = () => void openWorkspace('settings').catch(failure);
el('refresh-history').onclick = () => void refresh();
el('task-search').oninput = renderTasks; el('record-search').oninput = renderConversation;
