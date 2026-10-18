import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Settings } from './types';

/** ST keeps only this process-scoped token; provider secrets stay in Electron main. */
export async function startModelProxy(getSettings: () => Settings) {
  const token = randomBytes(32).toString('hex');
  const controllers = new Set<AbortController>();
  const abortAll = () => { for (const controller of controllers) controller.abort(); };
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    const settings = { ...getSettings() };
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: settings.deepseekModel, object: 'model' }] })); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    if (!settings.deepseekKey) { response.writeHead(503).end('未配置对话 API 密钥'); return; }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 120_000);
    response.on('close', () => controller.abort());
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 4_000_000) throw new Error('请求过大'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(input.messages)) throw new Error('消息无效');
      const body = { messages: input.messages, model: settings.deepseekModel, stream: !!input.stream,
        max_tokens: Math.min(Number(input.max_tokens) || 1024, 4096), temperature: Number(input.temperature) || 0.8,
        ...(input.top_p !== undefined ? { top_p: input.top_p } : {}),
      };
      const upstream = await fetch(`${settings.deepseekUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseekKey}` }, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        // Provider errors may include credentials or the entire prompt. Do not forward their bodies.
        response.writeHead(upstream.status).end(JSON.stringify({ error: { message: `模型服务返回 HTTP ${upstream.status}` } })); return;
      }
      response.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
      for await (const chunk of upstream.body) { if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal }); }
      response.end();
    } catch { if (!response.headersSent) response.writeHead(502); response.end(JSON.stringify({ error: { message: '模型请求失败或超时，请检查配置与网络' } })); }
    finally { clearTimeout(timer); controllers.delete(controller); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/v1`, token, abortAll, close: () => { abortAll(); server.closeAllConnections(); server.close(); } };
}
