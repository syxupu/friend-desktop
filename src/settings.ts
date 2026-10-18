import { safeStorage } from 'electron';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Settings, PublicSettings } from './types';
import { providers, validateUrl } from './providers';
export { validateUrl } from './providers';
export const defaults: Settings = {
  userName: '你', apiProvider: 'deepseek', petScale: 1, deepseekUrl: 'https://api.deepseek.com/v1', deepseekModel: 'deepseek-flash', deepseekKey: '',
  mimoUrl: 'https://api.xiaomimimo.com/v1', mimoModel: 'mimo-v2.5-tts', mimoKey: '', voice: '茉莉',
  voiceStyle: '自然的中文女声，语气温柔、略带调皮。', ttsEnabled: true, keepAwake: true, windowObservationEnabled: true, chatAlwaysOnTop: false,
};
export function publicSettings(settings: Settings): PublicSettings {
  return { ...settings, deepseekKey: '', mimoKey: '', hasDeepseekKey: !!settings.deepseekKey, hasMimoKey: !!settings.mimoKey };
}
export class SettingsStore {
  value = { ...defaults };
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'settings.json'), 'utf8'));
      const { secrets, ...plain } = data;
      this.value = { ...defaults, ...plain };
      if (!plain.apiProvider) this.value.apiProvider = providers.find(provider => provider.url === this.value.deepseekUrl)?.id || 'custom';
      if (!Number.isFinite(this.value.petScale) || this.value.petScale < .5 || this.value.petScale > 2) this.value.petScale = 1;
      if (secrets && safeStorage.isEncryptionAvailable()) Object.assign(this.value, JSON.parse(safeStorage.decryptString(Buffer.from(secrets, 'base64'))));
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('设置无法读取，请检查本机数据文件'); }
    return this.value;
  }
  save(patch: Partial<Settings>): Promise<void> {
    const copy = { ...patch };
    const task = this.writes.catch(() => {}).then(() => this.saveNow(copy));
    this.writes = task; return task;
  }
  private async saveNow(patch: Partial<Settings>) {
    const candidate = { ...this.value };
    for (const key of Object.keys(defaults) as (keyof Settings)[]) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== typeof defaults[key]) throw new Error('设置格式不正确');
      (candidate as any)[key] = patch[key];
    }
    candidate.deepseekUrl = validateUrl(candidate.deepseekUrl); candidate.mimoUrl = validateUrl(candidate.mimoUrl);
    if (!providers.some(provider => provider.id === candidate.apiProvider)) throw new Error('请选择有效的 API 供应商');
    if (!Number.isFinite(candidate.petScale) || candidate.petScale < .5 || candidate.petScale > 2) throw new Error('桌宠大小应为 50%–200%');
    if (candidate.deepseekUrl !== validateUrl(this.value.deepseekUrl) && !Object.hasOwn(patch, 'deepseekKey') && candidate.deepseekKey) throw new Error('API 地址已改变，请填写新密钥或清除旧密钥后保存');
    if (!candidate.userName.trim() || !candidate.deepseekModel.trim() || !candidate.voice.trim()) throw new Error('请填写称呼、对话模型和音色');
    if (candidate.mimoModel !== 'mimo-v2.5-tts') throw new Error('当前原型支持 MiMo 预置音色模型');
    if ((candidate.deepseekKey || candidate.mimoKey) && !safeStorage.isEncryptionAvailable()) throw new Error('Windows 加密存储不可用，密钥未保存');
    const { deepseekKey, mimoKey, ...plain } = candidate;
    const secrets = (deepseekKey || mimoKey) ? safeStorage.encryptString(JSON.stringify({ deepseekKey, mimoKey })).toString('base64') : '';
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'settings.json');
    await writeFile(`${file}.tmp`, JSON.stringify({ ...plain, secrets }, null, 2), 'utf8');
    await rename(`${file}.tmp`, file); this.value = candidate;
  }
}
