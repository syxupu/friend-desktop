import type { AppState } from './types';
import { petScale, petWidth } from './pet-layout';
const fox = document.getElementById('fox') as HTMLImageElement;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reply = el('pet-reply'), text = el('reply-text'), input = el<HTMLTextAreaElement>('pet-input');
let collapsed = false, latestSignature = '', localError = '', sending = false;
function layout() { if (!dragging) window.friend.layoutPet(reply.hidden ? 0 : Math.min(220, Math.ceil(reply.getBoundingClientRect().height) + 4)); }
new ResizeObserver(layout).observe(reply);
function renderReply() {
  const latest = state?.petReplySuppressed ? undefined : state?.messages.findLast(message => message.role === 'assistant' || message.role === 'notice');
  const signature = latest?.id || '';
  if (signature !== latestSignature) { latestSignature = signature; collapsed = false; }
  const content = localError || state?.error || latest?.text || (latest?.pending ? '正在思考…' : '');
  reply.hidden = collapsed || !content;
  const nearEnd = text.scrollHeight - text.scrollTop - text.clientHeight < 32;
  if (text.textContent !== content) { text.textContent = content; if (nearEnd) text.scrollTop = text.scrollHeight; }
  el('reply-who').textContent = localError || state?.error ? '提示' : latest?.pending ? `${state.character} · 正在回复` : latest?.cancelled ? '回复已停止' : state?.character || '陪伴回复';
  el('pet-stop-audio').hidden = !state?.speaking;
  requestAnimationFrame(layout);
}
let state: AppState;
let dragging = false;
let pointer: { x: number; y: number; wx: number; wy: number } | null = null;
let blinkTimer: ReturnType<typeof setTimeout>;
const sprite = (name: string) => { fox.src = `../assets/pets/wanxiang-fox/sprites/${name}.png`; };
function update(next: AppState) {
  state = next;
  const scale = petScale(next.settings.petScale);
  document.documentElement.style.setProperty('--pet-panel-width', `${petWidth(scale)}px`);
  document.documentElement.style.setProperty('--fox-width', `${148 * scale}px`);
  document.documentElement.style.setProperty('--fox-height', `${168 * scale}px`);
  el<HTMLButtonElement>('pet-send').disabled = sending || next.busy || next.configuring || !next.tavernReady;
  el('pet-send').hidden = next.busy;
  el('pet-stop').hidden = !next.busy;
  input.placeholder = next.tavernReady ? '和我说话… Enter 发送' : '对话服务正在准备…';
  renderReply();
  if (dragging) return;
  fox.classList.toggle('speaking', next.speaking);
  fox.classList.toggle('rest', next.study.mode === 'break');
  if (next.speaking) sprite('sit');
  else if (next.busy) sprite('wait');
  else if (next.study.mode === 'break') sprite('sleep');
  else sprite('sit');
}
function scheduleBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => {
    if (state && !dragging && !state.busy && !state.speaking && state.study.mode !== 'break') { sprite('blink'); setTimeout(() => state && update(state), 140); }
    scheduleBlink();
  }, 3800 + Math.random() * 2600);
}
fox.addEventListener('pointerdown', event => { if (event.button !== 0) return; pointer = { x: event.screenX, y: event.screenY, wx: window.screenX, wy: window.screenY }; fox.setPointerCapture(event.pointerId); });
fox.addEventListener('pointermove', event => {
  if (!pointer) return;
  const dx = event.screenX - pointer.x, dy = event.screenY - pointer.y;
  if (!dragging && Math.hypot(dx, dy) > 5) { dragging = true; fox.classList.add('dragging'); sprite(['drag', 'drag2', 'drag3'][Math.floor(Math.random() * 3)]); }
  if (dragging) window.friend.movePet(pointer.wx + dx, pointer.wy + dy);
});
function finishPointer(event: PointerEvent) {
  if (!pointer) return;
  const moved = dragging; pointer = null; dragging = false; fox.classList.remove('dragging');
  if (fox.hasPointerCapture(event.pointerId)) fox.releasePointerCapture(event.pointerId);
  if (state) update(state);
  if (!moved && event.type === 'pointerup') { input.focus(); collapsed = false; renderReply(); }
}
fox.addEventListener('pointerup', finishPointer); fox.addEventListener('pointercancel', finishPointer);
fox.addEventListener('lostpointercapture', finishPointer);
async function run(operation: () => Promise<void>) {
  try { localError = ''; await operation(); }
  catch (cause) { localError = String(cause).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, ''); collapsed = false; }
  finally { if (state) update(state); }
}
fox.addEventListener('contextmenu', event => { event.preventDefault(); void run(() => window.friend.action('settings')); });
el('pet-close-reply').onclick = () => { collapsed = true; renderReply(); };
el('pet-stop').onclick = () => void run(() => window.friend.action('stop-generation'));
el('pet-stop-audio').onclick = () => void run(() => window.friend.action('stop-audio'));
el<HTMLFormElement>('pet-form').onsubmit = event => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value || !state?.tavernReady || state.busy || state.configuring || sending) return;
  sending = true; input.value = ''; collapsed = false; update(state);
  void run(async () => {
    try { await window.friend.send(value); }
    catch (cause) { if (!input.value) input.value = value; throw cause; }
    finally { sending = false; }
  });
};
input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); el<HTMLFormElement>('pet-form').requestSubmit(); } };
window.friend.onState(update); void window.friend.getState().then(update); scheduleBlink();
