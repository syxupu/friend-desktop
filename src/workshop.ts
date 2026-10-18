import type { AppState, CharacterDocument, CharacterFields, CompanionPreferences } from './types';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = el<HTMLFormElement>('role-form'), preferencesForm = el<HTMLFormElement>('companion-form');
const fieldNames = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const;
let current: AppState, selected: CharacterDocument | undefined, working = false, initialized = false;
let fieldBase = '', preferenceBase = '';
const fieldValues = () => Object.fromEntries(fieldNames.map(key => [key, (form.elements.namedItem(key) as HTMLInputElement).value])) as unknown as CharacterFields;
function preferenceValues(): CompanionPreferences {
  const input = (key: string) => preferencesForm.elements.namedItem(key) as HTMLInputElement;
  return { length: input('length').value as CompanionPreferences['length'], actions: input('actions').value as CompanionPreferences['actions'], noFollowUp: input('noFollowUp').checked, studyStyle: input('studyStyle').value, breakStyle: input('breakStyle').value };
}
const fieldsDirty = () => !!fieldBase && JSON.stringify(fieldValues()) !== fieldBase;
const preferencesDirty = () => !!preferenceBase && JSON.stringify(preferenceValues()) !== preferenceBase;
function confirmDiscard() { return !(fieldsDirty() || preferencesDirty()) || window.confirm('有未保存的角色内容或陪伴偏好，确定放弃这些编辑吗？'); }
function status(text: string) { el('role-status').textContent = text; }
function error(cause: unknown) { el('role-error').textContent = String(cause).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''); el('role-error').hidden = false; }
function fillFields(fields: CharacterFields) {
  for (const key of fieldNames) (form.elements.namedItem(key) as HTMLInputElement).value = fields[key];
  fieldBase = JSON.stringify(fieldValues()); el('role-preview').hidden = true; el('role-adopt-preview').hidden = true;
}
function fillPreferences(preferences: CompanionPreferences) {
  for (const [key, value] of Object.entries(preferences)) {
    const input = preferencesForm.elements.namedItem(key) as HTMLInputElement;
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = String(value);
  }
  preferenceBase = JSON.stringify(preferenceValues());
}
function acceptDocument(value: CharacterDocument) {
  selected = value; initialized = true; fillFields(value.fields); fillPreferences(value.preferences);
  el('role-editor-title').textContent = '快速编辑';
  el('role-lore-summary').textContent = `角色书与高级内容 · ${value.lore.length} 条设定`;
  el('role-world').textContent = value.linkedWorld ? `关联酒馆世界书：${value.linkedWorld}。删除关联条目时为本角色另存独立世界书，保留原共享书。` : '没有关联的酒馆世界书。';
  el('role-lore-items').replaceChildren(...value.lore.map(entry => {
    const details = document.createElement('details'), title = document.createElement('summary'), content = document.createElement('pre');
    const label = document.createElement('span'); label.textContent = `${entry.title} · ${entry.enabled ? entry.constant ? '常驻' : '条件触发' : '已停用'} · ${{ both: '角色书 / 世界书', embedded: '内嵌角色书', world: '关联世界书' }[entry.source]}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'lore-delete danger'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除设定：${entry.title}`);
    remove.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      if (working || !selected) return;
      if (fieldsDirty() || preferencesDirty()) { error(new Error('请先保存角色编辑和陪伴偏好，再删除条目')); return; }
      if (!window.confirm(`删除“${entry.title}”这条设定？关联世界书的修改仅应用于本角色的独立副本。`)) return;
      void operation(async () => { acceptDocument(await window.friend.deleteLore(value.avatar, value.loreRevision, entry.key)); status(selected?.warning || '条目已删除并保存。'); });
    };
    title.append(label, remove);
    content.textContent = entry.content; content.className = 'role-preview'; details.append(title, content); return details;
  }));
  if (value.warning) status(value.warning);
  renderWorkshop(current);
}
async function listRoles(preferred = selected?.avatar || current.characterAvatar) {
  const characters = await window.friend.listCharacters(), select = el<HTMLSelectElement>('role-list');
  select.replaceChildren(...characters.map(character => { const option = document.createElement('option'); option.value = character.avatar; option.textContent = `${character.name} · ${character.avatar}${character.avatar === current.characterAvatar ? '（当前使用）' : ''}`; return option; }));
  if (!characters.length || !preferred) { const option = document.createElement('option'); option.value = ''; option.textContent = '新角色草稿'; select.prepend(option); }
  if (characters.some(character => character.avatar === preferred)) select.value = preferred;
  else if (!preferred) select.value = '';
  return characters;
}
export function renderWorkshop(state: AppState) {
  current = state;
  const blocked = working || state.busy || state.configuring;
  for (const id of ['role-new', 'role-refresh', 'role-list']) el<HTMLButtonElement>(id).disabled = blocked;
  for (const id of ['role-save', 'role-copy', 'role-use', 'role-advanced', 'role-new-chat', 'companion-save']) {
    el<HTMLButtonElement>(id).disabled = blocked || state.study.mode !== 'idle' || (id !== 'role-save' && !selected);
  }
  el<HTMLButtonElement>('role-new-chat').disabled ||= !state.tavernReady || selected?.avatar !== state.characterAvatar;
  for (const input of preferencesForm.querySelectorAll<HTMLInputElement>('input,select,textarea')) input.disabled = !selected || working;
  for (const input of form.querySelectorAll<HTMLInputElement>('input,textarea')) input.disabled = working;
  for (const id of ['role-preview-button', 'role-adopt-preview']) el<HTMLButtonElement>(id).disabled = working;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.lore-delete')) button.disabled = blocked || state.study.mode !== 'idle';
  el('role-dirty').textContent = fieldsDirty() ? '角色内容未保存' : '';
  el('companion-dirty').textContent = preferencesDirty() ? '陪伴偏好未保存' : '';
}
async function operation(action: () => Promise<void>) {
  if (working) return;
  working = true; el('role-error').hidden = true; renderWorkshop(current);
  try { await action(); }
  catch (cause) { error(cause); }
  finally { working = false; renderWorkshop(await window.friend.getState()); }
}
function newDraft() {
  selected = undefined; initialized = true;
  fillFields({ name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' });
  fillPreferences({ length: 'original', actions: 'original', noFollowUp: false, studyStyle: '', breakStyle: '' });
  el('role-editor-title').textContent = '快捷新建'; el('role-lore-summary').textContent = '角色书与高级内容'; el('role-lore-items').replaceChildren(); el('role-world').textContent = '新角色可在保存后通过酒馆添加世界书。';
  el<HTMLSelectElement>('role-list').value = ''; status('填写名称、基本人设、说话风格与关系。保存后可单独设置陪伴偏好。');
  renderWorkshop(current); el('role-name').focus();
}
document.addEventListener('friend:open-characters', () => void operation(async () => {
  const characters = await listRoles();
  if (!initialized) {
    const avatar = characters.find(c => c.avatar === current.characterAvatar)?.avatar ?? characters[0]?.avatar;
    if (avatar) { acceptDocument(await window.friend.getCharacter(avatar)); status('保存角色卡与陪伴偏好分别生效；有学习任务时可先编辑，结束任务后再保存。'); }
    else newDraft();
  }
}));
document.addEventListener('friend:leave-characters', event => {
  const dirty = fieldsDirty() || preferencesDirty();
  if (!confirmDiscard()) { event.preventDefault(); return; }
  if (dirty) {
    fillFields(selected?.fields ?? { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' });
    fillPreferences(selected?.preferences ?? { length: 'original', actions: 'original', noFollowUp: false, studyStyle: '', breakStyle: '' });
  }
});
for (const target of [form, preferencesForm]) target.addEventListener('input', () => renderWorkshop(current));
el('role-new').onclick = () => { if (confirmDiscard()) newDraft(); };
el('role-list').onchange = () => {
  const avatar = el<HTMLSelectElement>('role-list').value;
  if (!confirmDiscard()) { el<HTMLSelectElement>('role-list').value = selected?.avatar ?? ''; return; }
  if (avatar) void operation(async () => { acceptDocument(await window.friend.getCharacter(avatar)); status('已读取角色。原始描述和内嵌角色书完整保留。'); });
};
el('role-refresh').onclick = () => { if (confirmDiscard()) void operation(async () => { const list = await listRoles(); const avatar = selected?.avatar ?? list[0]?.avatar; if (avatar) { acceptDocument(await window.friend.getCharacter(avatar)); status('已重新读取角色与陪伴偏好。'); } }); };
form.onsubmit = event => { event.preventDefault(); void operation(async () => {
  const dirtyPreferences = preferencesDirty(), oldPreferenceRevision = selected?.preferenceRevision;
  const doc = await window.friend.saveCharacter({ ...(selected ? { avatar: selected.avatar, revision: selected.revision } : {}), fields: fieldValues() });
  const draftPreferences = preferenceValues();
  acceptDocument(doc);
  if (dirtyPreferences && oldPreferenceRevision) { selected!.preferenceRevision = oldPreferenceRevision; fillPreferences(doc.preferences); for (const [key, value] of Object.entries(draftPreferences)) { const input = preferencesForm.elements.namedItem(key) as HTMLInputElement; if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = String(value); } }
  current = await window.friend.getState(); await listRoles(doc.avatar);
  status(doc.warning || '角色卡已保存；陪伴偏好请单独保存。新建角色可点击“使用此角色”。');
}); };
preferencesForm.onsubmit = event => { event.preventDefault(); if (!selected) return; void operation(async () => {
  const updated = await window.friend.saveCompanionPreferences(selected!.avatar, selected!.preferenceRevision, preferenceValues());
  selected!.preferences = updated.preferences; selected!.preferenceRevision = updated.preferenceRevision;
  fillPreferences(updated.preferences); status('陪伴偏好已保存，从下一次回复开始使用。');
}); };
el('role-copy').onclick = () => void operation(async () => {
  if (!selected) return;
  if (fieldsDirty() || preferencesDirty()) throw new Error('请先保存编辑，或重新读取后再另存副本。');
  const copy = await window.friend.copyCharacter(selected.avatar, selected.revision); acceptDocument(copy); await listRoles(copy.avatar);
  status(copy.warning || '桌宠版副本已创建，原卡保持不变。可在此调整人设和开场，再点击使用此角色。');
});
el('role-use').onclick = () => void operation(async () => {
  if (!selected) return;
  if (fieldsDirty() || preferencesDirty()) throw new Error('请先保存编辑再使用角色。');
  await window.friend.selectCharacter(selected.avatar); current = await window.friend.getState(); acceptDocument(await window.friend.getCharacter(selected.avatar)); await listRoles(); status(`正在使用「${current.character}」。`);
});
el('role-advanced').onclick = () => void operation(async () => {
  if (!selected) return;
  if (fieldsDirty() || preferencesDirty()) throw new Error('请先保存编辑，避免与酒馆高级编辑冲突。');
  await window.friend.selectCharacter(selected.avatar); await window.friend.action('tavern'); status('已打开此角色的酒馆窗口。高级修改完成后，点击“重新读取”同步到此页面。');
});
el('role-preview-button').onclick = () => {
  let text = fieldValues().first_mes;
  text = text.replace(/<!--[^]*?-->/g, '').replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi, '').replace(/<br\s*\/?\s*>|<\/(p|div|section|li)>/gi, '\n').replace(/<[^>]*>/g, '');
  const decoder = document.createElement('textarea'); decoder.innerHTML = text;
  const plain = decoder.value.trim(); el('role-preview').textContent = plain || '（没有角色开场白）'; el('role-preview').dataset.plain = plain; el('role-preview').hidden = false; el('role-adopt-preview').hidden = false;
};
el('role-adopt-preview').onclick = () => { el<HTMLTextAreaElement>('role-greeting').value = el('role-preview').dataset.plain || ''; renderWorkshop(current); status('已替换为预览中的纯文本开场，保存角色卡后生效。'); };
el('role-new-chat').onclick = () => void operation(async () => {
  if (fieldsDirty() || preferencesDirty()) throw new Error('请先保存编辑，再开始新聊天。');
  await window.friend.newCharacterChat(); if (selected) acceptDocument(await window.friend.getCharacter(selected.avatar)); status('旧聊天已归档，新聊天为空白，等待你输入；结束学习本段后会主动回复一次。');
});
