import type { AppState } from './types';
const fox = document.getElementById('fox') as HTMLImageElement;
const badge = document.getElementById('badge')!;
let state: AppState;
let dragging = false;
let pointer: { x: number; y: number; wx: number; wy: number } | null = null;
let blinkTimer: ReturnType<typeof setTimeout>;
const sprite = (name: string) => { fox.src = `../assets/pets/wanxiang-fox/sprites/${name}.png`; };
function update(next: AppState) {
  state = next;
  if (dragging) return;
  fox.classList.toggle('speaking', next.speaking);
  fox.classList.toggle('rest', next.study.mode === 'break');
  if (next.speaking) { sprite('sit'); badge.textContent = '正在和你说话…'; }
  else if (next.busy) { sprite('wait'); badge.textContent = '让我想想…'; }
  else if (next.study.mode === 'break') { sprite('sleep'); badge.textContent = '休息一下吧'; }
  else { sprite('sit'); badge.textContent = next.study.mode === 'study' ? '学习加油，我陪着你' : next.study.mode === 'paused' ? '等你回来' : '点击和我聊聊'; }
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
  if (!moved && event.type === 'pointerup') void window.friend.action('chat');
}
fox.addEventListener('pointerup', finishPointer); fox.addEventListener('pointercancel', finishPointer);
fox.addEventListener('contextmenu', event => { event.preventDefault(); void window.friend.action('chat'); });
window.friend.onState(update); void window.friend.getState().then(update); scheduleBlink();
