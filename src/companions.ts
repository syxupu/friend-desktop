import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { CharacterFields, CompanionPreferences, Mode } from './types';
export const fieldNames = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const;
export const defaultPreferences: CompanionPreferences = { length: 'original', actions: 'original', noFollowUp: false, studyStyle: '', breakStyle: '' };
export const revisionOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fieldsFromData = (data: Record<string, unknown>) => Object.fromEntries(fieldNames.map(key => [key, String(data[key] ?? '')])) as unknown as CharacterFields;
export function validateFields(input: unknown): CharacterFields {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('角色内容格式不正确');
  const fields = {} as CharacterFields;
  for (const key of fieldNames) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length > (key === 'name' ? 100 : 100000) || value === '__@@UNSET@@__') throw new Error('角色字段格式或长度不正确');
    fields[key] = value;
  }
  if (!fields.name.trim()) throw new Error('请填写角色名称');
  fields.name = fields.name.trim(); return fields;
}
export function validatePreferences(input: unknown): CompanionPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('陪伴偏好格式不正确');
  const p = input as CompanionPreferences;
  if (!['original', 'brief', 'balanced', 'detailed'].includes(p.length) || !['original', 'none', 'light'].includes(p.actions) || typeof p.noFollowUp !== 'boolean' || ['studyStyle', 'breakStyle'].some(k => typeof p[k as keyof CompanionPreferences] !== 'string' || String(p[k as keyof CompanionPreferences]).length > 2000)) throw new Error('陪伴偏好格式或长度不正确');
  return { length: p.length, actions: p.actions, noFollowUp: p.noFollowUp, studyStyle: p.studyStyle, breakStyle: p.breakStyle };
}
export function companionPrompt(p: CompanionPreferences, mode: Mode): string {
  const parts: string[] = [];
  if (p.length !== 'original') parts.push({ brief: '回复简短，通常一至三句话，避免长篇叙述。', balanced: '回复篇幅适中，围绕当前话题展开。', detailed: '需要解释时可详细展开，但避免重复。' }[p.length]);
  if (p.actions === 'none') parts.push('只写角色说出的台词，不写动作和旁白。');
  if (p.actions === 'light') parts.push('动作描写保持简短少量，以自然对话为主。');
  if (p.noFollowUp) parts.push('不要每条回复都追问；用户不回应时保持安静。');
  const context = mode === 'study' || mode === 'paused' ? p.studyStyle : mode === 'break' ? p.breakStyle : '';
  if (context.trim()) parts.push(`用户对当前陪伴方式的偏好：${context}`);
  return parts.length ? `用户的陪伴表达偏好（不改变学习状态、软件权限或计时规则）：\n${parts.join('\n')}` : '';
}
/** Independent local preferences; commit memory only after atomic disk replacement. */
export class CompanionStore {
  private value: Record<string, CompanionPreferences> = Object.create(null);
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load() {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, 'companions.json'), 'utf8'));
      if (parsed.version !== 1 || !parsed.characters || typeof parsed.characters !== 'object' || Array.isArray(parsed.characters)) throw new Error('Invalid preferences');
      for (const [key, value] of Object.entries(parsed.characters)) this.value[key] = validatePreferences(value);
    } catch (cause: any) { if (cause.code !== 'ENOENT') throw new Error('陪伴偏好无法读取，请检查本机数据文件'); }
  }
  get(avatar: string) { return { ...(this.value[avatar] ?? defaultPreferences) }; }
  save(avatar: string, expected: string, input: unknown) {
    const preferences = validatePreferences(input);
    const task = this.writes.catch(() => {}).then(async () => {
      if (revisionOf(this.get(avatar)) !== expected) throw new Error('陪伴偏好已变化，请重新读取后再保存');
      const next = { ...this.value, [avatar]: preferences };
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, 'companions.json');
      await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, characters: next }, null, 2), 'utf8');
      await rename(`${file}.tmp`, file); this.value = next;
    });
    this.writes = task; return task;
  }
}
