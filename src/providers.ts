export const providers = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { id: 'siliconflow', name: '硅基流动', url: 'https://api.siliconflow.cn/v1' },
  { id: 'dashscope', name: '阿里云百炼（国内）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'moonshot', name: 'Moonshot / Kimi（国内）', url: 'https://api.moonshot.cn/v1' },
  { id: 'custom', name: '自定义 · OpenAI 兼容', url: '' },
] as const;

export function validateUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('API 地址需为 HTTPS；本机服务可用 HTTP');
  return url.toString().replace(/\/$/, '');
}
export interface ModelQuery { url: string; key?: string; useSavedKey?: boolean }
export function modelCredentials(query: ModelQuery, saved: { deepseekUrl: string; deepseekKey: string }) {
  if (!query || typeof query.url !== 'string' || query.url.length > 2048 || (query.key !== undefined && typeof query.key !== 'string') || (query.useSavedKey !== undefined && typeof query.useSavedKey !== 'boolean')) throw new Error('模型查询格式不正确');
  const url = validateUrl(query.url);
  let key = query.key?.trim() || '';
  if (!key && query.useSavedKey) {
    if (url !== validateUrl(saved.deepseekUrl)) throw new Error('地址已改变，请为新地址填写密钥');
    key = saved.deepseekKey;
  }
  if (!key || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('请先填写 API 密钥');
  return { url, key };
}
export async function fetchModels(query: ModelQuery, saved: { deepseekUrl: string; deepseekKey: string }, request: typeof fetch = fetch): Promise<string[]> {
  const { url, key } = modelCredentials(query, saved);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await request(`${url}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      void response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new Error('密钥无效或没有访问模型列表的权限');
      if ([404, 405].includes(response.status)) throw new Error('此地址不支持模型列表，请检查 API 基础地址或手动填写模型');
      throw new Error(`模型列表请求失败（HTTP ${response.status}），请稍后重试或手动填写模型`);
    }
    if (!response.body) throw new Error('模型列表为空');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 4 * 1024 * 1024) { controller.abort(); throw new Error('模型列表过大，请手动填写模型'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data: any;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('返回的模型列表不是有效 JSON，请检查 API 地址'); }
    if (!Array.isArray(data?.data)) throw new Error('此接口未返回 OpenAI 格式的模型列表，请手动填写模型');
    const ids: string[] = data.data.slice(0, 10000).flatMap((model: any) => typeof model?.id === 'string' && model.id.trim() && model.id.length <= 300 && !/[\x00-\x1f\x7f]/.test(model.id) ? [model.id.trim()] : []);
    const result = [...new Set(ids)].sort();
    if (!result.length) throw new Error('没有可选模型，请确认账号权限或手动填写模型');
    return result;
  } catch (cause) {
    if (cause instanceof Error && /^(密钥|此地址|模型列表|返回的|此接口|没有可选)/.test(cause.message)) throw cause;
    throw new Error(controller.signal.aborted ? '获取模型列表超时，请重试或手动填写模型' : '无法获取模型列表，请检查网络和 API 地址');
  } finally { clearTimeout(timer); }
}
