import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels, modelCredentials, validateUrl } from '../src/providers';
import { petSize, petWidth } from '../src/pet-layout';
const saved = { deepseekUrl: 'https://example.test/v1', deepseekKey: 'fictional-saved-key' };
test('model discovery uses a transient key, binds saved credentials to the exact base URL, and refuses unsafe addresses', () => {
  assert.deepEqual(modelCredentials({ url: saved.deepseekUrl + '/', useSavedKey: true }, saved), { url: saved.deepseekUrl, key: saved.deepseekKey });
  assert.deepEqual(modelCredentials({ url: 'https://other.test/v1', key: 'fictional-new-key' }, saved), { url: 'https://other.test/v1', key: 'fictional-new-key' });
  for (const url of ['https://other.test/v1', 'https://example.test/other']) assert.throws(() => modelCredentials({ url, useSavedKey: true }, saved), /地址已改变/);
  for (const url of ['http://example.test/v1', 'https://user:secret@example.test', 'https://example.test?key=secret', 'file:///secret']) assert.throws(() => validateUrl(url));
  assert.equal(validateUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
});
test('model lists are fetched with bearer auth and no redirects; IDs are bounded, deduplicated and sorted', async () => {
  const ids = await fetchModels({ url: saved.deepseekUrl, useSavedKey: true }, saved, async (url, options) => {
    assert.equal(url, saved.deepseekUrl + '/models'); assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as any).Authorization, 'Bearer fictional-saved-key'); assert.ok(options?.signal);
    return Response.json({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }, { id: 'bad\nvalue' }, { id: 'x'.repeat(301) }, null] });
  });
  assert.deepEqual(ids, ['alpha', 'zeta']);
});
test('model list failures never reveal provider response bodies or network errors', async () => {
  for (const status of [401, 403, 404, 429, 500]) await assert.rejects(fetchModels({ url: saved.deepseekUrl, useSavedKey: true }, saved, async () => new Response('fictional-secret-response', { status })), error => !String(error).includes('fictional-secret-response'));
  await assert.rejects(fetchModels({ url: saved.deepseekUrl, useSavedKey: true }, saved, async () => { throw new Error('fictional-sensitive-network-error'); }), /无法获取模型列表/);
  await assert.rejects(fetchModels({ url: saved.deepseekUrl, useSavedKey: true }, saved, async () => Response.json({ unexpected: 'fictional-secret' })), /未返回 OpenAI/);
  await assert.rejects(fetchModels({ url: saved.deepseekUrl, useSavedKey: true }, saved, async () => new Response('<html>fictional-secret</html>')), /不是有效 JSON/);
  await assert.rejects(fetchModels({ url: saved.deepseekUrl, useSavedKey: true }, saved, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))), /过大/);
});
test('pet width depends only on scale, while reply height stays bounded', () => {
  const work = { width: 1920, height: 1080 };
  assert.deepEqual(petSize(1, 0, work), { width: 324, height: 252 });
  assert.equal(petSize(1.5, 100, work).height - petSize(1, 100, work).height, 84);
  assert.deepEqual(petSize(99, 999, { width: 300, height: 500 }), { width: 648, height: 500 });
  for (const scale of [.5, 1, 1.5, 2]) {
    assert.equal(petWidth(scale), Math.round(324 * scale));
    for (const width of [300, 800, 1920, 3840]) for (const reply of [0, 100, 220]) assert.equal(petSize(scale, reply, { width, height: 1080 }).width, petWidth(scale));
  }
  assert.deepEqual(petSize(NaN, 0, work), petSize(1, 0, work));
});
