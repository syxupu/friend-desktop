import type { AppState, Settings, ChatMessage } from './types';
import { renderDashboard, openWorkspace } from './dashboard';
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const settingsDialog = byId<HTMLDialogElement>('settings');
const settingsForm = byId<HTMLFormElement>('settings-form');
const messageInput = byId<HTMLTextAreaElement>('message');
const editor = byId<HTMLDialogElement>('message-editor');
const deleteDialog = byId<HTMLDialogElement>('message-delete');
const emptyMessages = byId('messages').firstElementChild!.cloneNode(true);
let selectedMessage: ChatMessage | null = null;
let editingRequest = false;
let current: AppState;
let clearDeepseek = false, clearMimo = false;
let historySignature = '';
let previousStateError: string | undefined;
let audio: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let audioId: string | null = null;
const time = (ms: number) => { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':'); };
function showError(text: string) { byId('error').textContent = text; byId('error').hidden = !text; }
async function run(fn: () => Promise<unknown>) { try { showError(''); await fn(); } catch (e) { showError(String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')); } }
function render(state: AppState) {
  current = state;
  renderDashboard(state);
  const pinned = state.settings.chatAlwaysOnTop;
  byId('pin-button').setAttribute('aria-pressed', String(pinned));
  byId('pin-button').setAttribute('aria-label', pinned ? '取消置顶聊天' : '置顶聊天');
  byId('pin-button').title = pinned ? '已置顶 · 点击取消' : '置顶聊天';
  byId('character').textContent = state.character;
  byId('connection').textContent = state.connection;
  byId('online-dot').classList.toggle('ready', state.tavernReady);
  const mode = state.study.mode;
  byId('mode').textContent = { idle: '等待开始', study: '专注学习', paused: '已暂停', break: '休息一下' }[mode];
  byId('timer').textContent = time(state.study.elapsedMs);
  byId('start').hidden = mode === 'study' || mode === 'paused';
  byId('start').textContent = mode === 'break' ? '开始下一段' : '开始学习';
  byId('pause').hidden = mode !== 'study' && mode !== 'paused'; byId('pause').textContent = mode === 'paused' ? '继续' : '暂停';
  byId('end').hidden = mode !== 'study' && mode !== 'paused'; byId('finish').hidden = mode === 'idle';
  for (const id of ['start', 'pause', 'end', 'finish']) byId<HTMLButtonElement>(id).disabled = state.configuring;
  const topic = byId<HTMLInputElement>('topic'); topic.disabled = mode === 'study' || mode === 'paused';
  if (document.activeElement !== topic && state.study.topic) topic.value = state.study.topic;
  byId('study-meta').textContent = mode === 'break' ? `任务累计学习 ${time(state.study.taskElapsedMs)} · 下一段由你主动开始` : mode === 'idle' ? '由你决定何时学习、何时休息' : `第 ${state.study.segment} 段 · 睡眠时暂停，唤醒后继续`;
  byId('rounds').textContent = `本段交流 ${state.study.rounds} 轮`;
  byId<HTMLButtonElement>('send').disabled = state.busy || state.configuring || !state.tavernReady;
  byId('voice-label').textContent = state.speaking ? '正在说话' : state.busy ? '正在回应…' : state.settings.ttsEnabled ? '文字 · 语音' : '文字';
  byId('stop-audio').hidden = !state.speaking;
  byId('stop-generation').hidden = !state.busy;
  byId('restart-tavern').hidden = state.tavernReady || state.configuring || state.busy;
  byId('save-status').textContent = state.persistence.status === 'saved' ? '本机已保存 · 原型 0.2.0' : state.persistence.status === 'saving' ? '正在保存…' : '进度尚未保存';
  byId('save-warning').hidden = state.persistence.status !== 'error' && !state.exitWarning;
  byId('save-warning-text').textContent = state.exitWarning || state.persistence.error || '进度尚未保存，正在重试。';
  const observation = state.foreground;
  const currentWindow = observation.current;
  const displayed = currentWindow?.isOwnApp ? observation.lastExternal : currentWindow;
  byId('window-status').textContent = { inactive: '等待学习开始', disabled: '已关闭', locked: '锁屏 · 暂停读取', starting: '正在读取…', active: currentWindow?.isOwnApp ? '桌宠在前台 · 最近外部窗口' : '本机读取中', unavailable: '暂时无法读取', error: '读取组件不可用', unsupported: '仅支持 Windows' }[observation.status];
  byId('window-context').textContent = currentWindow?.isOwnApp ? '当前是桌宠窗口；以下是最近读到的外部窗口，可能已经变化。' : observation.status === 'error' ? '读取组件启动失败。请检查程序文件完整性后重启。' : '仅学习期间读取，不截图、不调用 AI；标题不能证明正在观看。';
  byId('window-app').textContent = displayed?.appName || displayed?.processName || '—';
  byId('window-process').textContent = displayed ? `${displayed.processName || '名称不可用'} · PID ${displayed.processId}` : '—';
  byId('window-title').textContent = displayed ? (displayed.title || '（窗口未提供标题）') : '—';
  byId('window-path').textContent = displayed ? (displayed.executablePath || '（当前权限下无法读取）') : '—';
  byId('window-time').textContent = displayed ? `读取于 ${new Date(displayed.observedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 不保存、不上传` : '暂停、休息和锁屏时停止读取并清空结果。';
  if (state.error) showError(state.error);
  else if (previousStateError) showError('');
  previousStateError = state.error;
  const signature = JSON.stringify([state.messages, state.busy, state.configuring, state.tavernReady, state.settings.userName, state.character]);
  if (signature !== historySignature) {
    historySignature = signature;
    const container = byId('messages');
    const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 65;
    if (state.messages.length) {
      const latest = state.messages.filter(message => message.role !== 'notice').at(-1);
      container.replaceChildren(...state.messages.map(message => {
        const item = document.createElement('article'); item.className = `message ${message.role}${message.pending ? ' pending' : ''}${message.failed ? ' failed' : ''}${message.cancelled ? ' cancelled' : ''}`;
        item.dataset.messageId = message.id;
        if (message.role === 'notice') {
          if (message.createdAt) {
            const stamp = document.createElement('time'); stamp.className = 'notice-time';
            stamp.dateTime = new Date(message.createdAt).toISOString();
            stamp.textContent = new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
            stamp.title = new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false });
            item.append(stamp);
          }
          const text = document.createElement('span'); text.textContent = message.text; item.append(text); return item;
        }
        const label = document.createElement('span'); label.className = 'message-label'; label.textContent = (message.role === 'user' ? state.settings.userName : state.character) + (message.cancelled ? ' · 已停止' : '');
        const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.text;
        item.append(label, bubble);
        if (message.id.startsWith('st-') && !message.pending) {
          const actions = document.createElement('div'); actions.className = 'message-actions';
          for (const [action, title] of [['edit', '编辑'], ['delete', '删除'], ...(message === latest && message.role === 'assistant' ? [['regenerate', '重新生成']] : [])]) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.dataset.action = action;
            button.disabled = state.busy || state.configuring || !state.tavernReady;
            button.onclick = () => {
              if (current.busy || current.configuring || !current.tavernReady) return;
              if (action === 'regenerate') { void run(() => window.friend.changeMessage({ action: 'regenerate', id: message.id, expectedText: message.text })); return; }
              selectedMessage = { ...message };
              if (action === 'edit') {
                byId<HTMLTextAreaElement>('edit-text').value = message.text; byId('edit-error').hidden = true;
                editor.showModal(); byId('edit-text').focus();
              } else { byId('delete-error').hidden = true; deleteDialog.showModal(); }
            };
            actions.append(button);
          }
          item.append(actions);
        }
        return item;
      }));
      if (follow || state.busy) container.scrollTop = container.scrollHeight;
    } else {
      const empty = emptyMessages.cloneNode(true) as HTMLElement;
      if (state.study.mode === 'break') empty.querySelector('p')!.textContent = '本段聊天已保存到学习中心。休息时可以继续聊，下一段由你开始。';
      else if (state.archive.taskCount) empty.querySelector('p')!.textContent = '聊天已保存在学习中心。开始下一次学习，或继续自由聊天。';
      container.replaceChildren(empty);
    }
  }
}
byId('pin-button').onclick = () => {
  const button = byId<HTMLButtonElement>('pin-button'); button.disabled = true;
  void run(async () => { try { await window.friend.pinChat(!current.settings.chatAlwaysOnTop); } finally { button.disabled = false; } });
};
function dismiss(dialog: HTMLDialogElement) { if (!editingRequest) { dialog.close(); selectedMessage = null; } }
for (const id of ['cancel-edit', 'discard-edit']) byId(id).onclick = () => dismiss(editor);
byId('cancel-delete').onclick = () => dismiss(deleteDialog);
for (const dialog of [editor, deleteDialog]) dialog.addEventListener('cancel', event => { if (editingRequest) event.preventDefault(); else selectedMessage = null; });
async function commitMessage(action: 'edit' | 'delete') {
  if (!selectedMessage || editingRequest) return;
  const selected = selectedMessage, dialog = action === 'edit' ? editor : deleteDialog;
  const error = byId(action === 'edit' ? 'edit-error' : 'delete-error'); error.hidden = true;
  editingRequest = true;
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
  try {
    await window.friend.changeMessage({ action, id: selected.id, expectedText: selected.text,
      ...(action === 'edit' ? { text: byId<HTMLTextAreaElement>('edit-text').value } : {}) });
    dialog.close(); selectedMessage = null;
  } catch (cause) { error.textContent = String(cause).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''); error.hidden = false; }
  finally { editingRequest = false; for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false; }
}
byId<HTMLFormElement>('message-edit-form').onsubmit = event => { event.preventDefault(); void commitMessage('edit'); };
byId('confirm-delete').onclick = () => void commitMessage('delete');
byId('chat-form').addEventListener('submit', event => {
  event.preventDefault(); if (current.busy || current.configuring || !current.tavernReady) return;
  const text = messageInput.value.trim(); if (!text) return; messageInput.value = '';
  void run(async () => { try { await window.friend.send(text); } catch (cause) { if (!messageInput.value) messageInput.value = text; throw cause; } });
});
messageInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!current.busy && !current.configuring && current.tavernReady) byId<HTMLFormElement>('chat-form').requestSubmit(); } });
byId('start').onclick = () => void run(() => window.friend.control('start', byId<HTMLInputElement>('topic').value));
byId('pause').onclick = () => void run(() => window.friend.control(current.study.mode === 'paused' ? 'resume' : 'pause'));
byId('end').onclick = () => void run(() => window.friend.control('end'));
byId('finish').onclick = () => void run(() => window.friend.control('finish'));
byId('hide-button').onclick = () => void window.friend.action('hide');
document.addEventListener('click', event => { const panel = byId<HTMLDetailsElement>('window-observation'); if (event.target instanceof Node && !panel.contains(event.target)) panel.open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') byId<HTMLDetailsElement>('window-observation').open = false; });
byId('stop-audio').onclick = () => void window.friend.action('stop-audio');
byId('stop-generation').onclick = () => void run(() => window.friend.action('stop-generation'));
byId('restart-tavern').onclick = () => void run(() => window.friend.action('restart-tavern'));
byId('retry-save').onclick = () => void run(() => window.friend.action('retry-save'));
byId('force-quit').onclick = () => void window.friend.action('force-quit');
byId('quit').onclick = () => void window.friend.action('quit');
byId('tavern').onclick = () => void window.friend.action('tavern');
byId('close-settings').onclick = () => void run(() => openWorkspace('history'));
byId('settings-button').onclick = () => void run(() => openWorkspace('settings'));
document.addEventListener('friend:open-settings', () => {
  clearDeepseek = clearMimo = false;
  for (const [name, value] of Object.entries(current.settings)) {
    const input = settingsForm.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
    else if (input) input.value = String(value);
  }
  (settingsForm.elements.namedItem('deepseekKey') as HTMLInputElement).placeholder = current.settings.hasDeepseekKey ? '已保存 · 留空保留原密钥' : '填写 DeepSeek 密钥';
  (settingsForm.elements.namedItem('mimoKey') as HTMLInputElement).placeholder = current.settings.hasMimoKey ? '已保存 · 留空保留原密钥' : '填写 MiMo 密钥';
  byId('book-info').textContent = `当前角色：${current.character} · 已导入 ${current.bookEntries} 条世界书`;
  byId('settings-error').hidden = true;
  byId('settings-saved').hidden = true;
  byId('settings-host').append(settingsDialog);
  if (!settingsDialog.open) settingsDialog.show();
});
byId('clear-deepseek').onclick = () => { clearDeepseek = true; const input = settingsForm.elements.namedItem('deepseekKey') as HTMLInputElement; input.value = ''; input.placeholder = '保存后清除密钥'; };
byId('clear-mimo').onclick = () => { clearMimo = true; const input = settingsForm.elements.namedItem('mimoKey') as HTMLInputElement; input.value = ''; input.placeholder = '保存后清除密钥'; };
settingsForm.addEventListener('submit', async event => {
  event.preventDefault(); const data = new FormData(settingsForm);
  const patch: Partial<Settings> = {};
  for (const name of ['userName', 'deepseekUrl', 'deepseekModel', 'mimoUrl', 'voice', 'voiceStyle'] as const) patch[name] = String(data.get(name) ?? '');
  patch.ttsEnabled = data.has('ttsEnabled'); patch.keepAwake = data.has('keepAwake');
  patch.windowObservationEnabled = data.has('windowObservationEnabled');
  const key = String(data.get('deepseekKey') ?? '').trim(); const ttsKey = String(data.get('mimoKey') ?? '').trim();
  if (key || clearDeepseek) patch.deepseekKey = key; if (ttsKey || clearMimo) patch.mimoKey = ttsKey;
  byId<HTMLButtonElement>('save-settings').disabled = true;
  try {
    await window.friend.saveSettings(patch); clearDeepseek = clearMimo = false;
    for (const name of ['deepseekKey', 'mimoKey']) (settingsForm.elements.namedItem(name) as HTMLInputElement).value = '';
    byId('settings-saved').hidden = false;
  }
  catch (e) { byId('settings-error').textContent = String(e); byId('settings-error').hidden = false; }
  finally { byId<HTMLButtonElement>('save-settings').disabled = false; }
});
function stopLocalAudio() {
  if (audio) { audio.onplaying = audio.onended = audio.onerror = null; audio.pause(); audio.src = ''; audio = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  if (audioId) window.friend.audioStatus(audioId, false);
  audioId = null;
}
window.friend.onAudio(async data => {
  stopLocalAudio(); if (!data) return;
  audioId = data.id;
  const bytes = Uint8Array.from(atob(data.data), c => c.charCodeAt(0));
  audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const instance = new Audio(audioUrl); audio = instance;
  instance.onplaying = () => { if (audio === instance) window.friend.audioStatus(data.id, true); };
  instance.onended = () => { if (audio === instance) stopLocalAudio(); };
  instance.onerror = () => { if (audio === instance) { showError('语音播放失败，文字已保留'); stopLocalAudio(); } };
  try { await instance.play(); } catch { if (audio === instance) { showError('语音未能播放，文字已保留'); stopLocalAudio(); } }
});
window.friend.onState(render);
void window.friend.getState().then(render);
