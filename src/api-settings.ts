import { providers } from './providers';
import type { PublicSettings } from './types';
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
const provider = document.querySelector<HTMLSelectElement>('[name="apiProvider"]')!;
const list = document.getElementById('api-model-list') as HTMLSelectElement;
const fetchButton = document.getElementById('fetch-models') as HTMLButtonElement;
const status = document.getElementById('api-model-status')!;
const scale = input('petScale'), scaleLabel = document.getElementById('pet-scale-value')!;
let revision = 0, saved: PublicSettings, cleared = false;
function canUseSavedKey() { return !cleared && !!saved?.hasDeepseekKey && input('deepseekUrl').value.trim().replace(/\/$/, '') === saved.deepseekUrl.replace(/\/$/, ''); }
for (const item of providers) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; provider.append(option); }
function invalidate() {
  revision++; list.replaceChildren(); list.hidden = true; status.textContent = '';
  if (saved) input('deepseekKey').placeholder = cleared ? '保存后清除密钥' : canUseSavedKey() ? '已保存 · 留空保留原密钥' : '填写此地址的 API 密钥';
}
export function resetApiSettings(settings: PublicSettings) { saved = settings; cleared = false; invalidate(); scaleLabel.textContent = `${Math.round(Number(scale.value) * 100)}%`; }
scale.oninput = () => { scaleLabel.textContent = `${Math.round(Number(scale.value) * 100)}%`; };
provider.onchange = () => {
  const preset = providers.find(item => item.id === provider.value);
  if (preset?.url) input('deepseekUrl').value = preset.url;
  input('deepseekModel').value = ''; input('deepseekKey').value = ''; invalidate();
};
for (const name of ['deepseekUrl', 'deepseekKey']) input(name).addEventListener('input', invalidate);
document.getElementById('clear-deepseek')!.addEventListener('click', () => { cleared = true; invalidate(); });
input('deepseekModel').addEventListener('input', () => { revision++; status.textContent = ''; });
list.onchange = () => { if (list.value) input('deepseekModel').value = list.value; };
fetchButton.onclick = async () => {
  const request = ++revision, url = input('deepseekUrl').value.trim(), key = input('deepseekKey').value.trim();
  fetchButton.disabled = true; list.hidden = true; status.textContent = '正在获取模型…';
  try {
    const models = await window.friend.listModels({ url, key, useSavedKey: !key && canUseSavedKey() });
    if (revision !== request) return;
    list.replaceChildren(...models.map(id => { const option = document.createElement('option'); option.value = option.textContent = id; return option; }));
    list.hidden = false;
    if (models.includes(input('deepseekModel').value)) list.value = input('deepseekModel').value;
    else { list.value = models[0]; input('deepseekModel').value = models[0]; }
    status.textContent = `已获取 ${models.length} 个模型。请选择对话模型；也可手动填写。`;
  } catch (cause) {
    if (revision === request) status.textContent = String(cause).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, '');
  } finally { fetchButton.disabled = false; }
};
