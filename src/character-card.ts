import { crc32, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxText = 16 * 1024 * 1024;
export const maxCardBytes = 32 * 1024 * 1024;
export function validAvatar(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && value.endsWith('.png') && !/[\\/\x00-\x1f]/.test(value) && !['.png', '..png'].includes(value);
}
function jsonCard(text: string): string {
  if (Buffer.byteLength(text) > maxText) throw new Error('角色设定过大（最多 16 MB）');
  let card;
  try { card = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('角色卡 JSON 无法解析'); }
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('角色卡格式不正确');
  if (!card.spec && typeof card.name === 'string') card = { spec: 'chara_card_v2', spec_version: '2.0', data: card };
  if (!['chara_card_v2', 'chara_card_v3'].includes(card.spec) || !card.data || typeof card.data !== 'object' || Array.isArray(card.data) || typeof card.data.name !== 'string' || !card.data.name.trim()) throw new Error('需要包含角色名称的 V2/V3 角色卡');
  for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions']) {
    if (card.data[key] !== undefined && typeof card.data[key] !== 'string') throw new Error('角色卡文本字段格式不正确');
  }
  if (card.data.character_book && !Array.isArray(card.data.character_book.entries)) throw new Error('角色卡世界书格式不正确');
  return JSON.stringify(card);
}
/** Read data only; prefer V3 metadata and preserve the PNG artwork. */
export function decodeCharacterCard(bytes: Buffer, extension: string): { json: string; png?: Buffer } {
  if (bytes.length > maxCardBytes) throw new Error('角色卡文件过大（最多 32 MB）');
  if (extension.toLowerCase() === '.json') return { json: jsonCard(bytes.toString('utf8')) };
  if (extension.toLowerCase() !== '.png') throw new Error('请选择 PNG 或 JSON 角色卡');
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('PNG 文件头不正确');
  const chunks: Buffer[] = [], cards: { key: string; text: string }[] = [];
  let offset = 8, ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据不完整');
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error('PNG 数据不完整');
    const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('PNG 校验失败');
    let cardChunk = false;
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const split = data.indexOf(0), key = data.toString('latin1', 0, split).toLowerCase();
      cardChunk = split > 0 && ['ccv3', 'chara'].includes(key);
      if (cardChunk) {
        let text: string;
        if (type === 'tEXt') text = data.subarray(split + 1).toString('latin1');
        else if (type === 'zTXt') {
          if (data[split + 1] !== 0) throw new Error('PNG 压缩格式不正确');
          text = inflateSync(data.subarray(split + 2), { maxOutputLength: maxText }).toString('latin1');
        } else {
          const languageEnd = data.indexOf(0, split + 3), translatedEnd = data.indexOf(0, languageEnd + 1);
          if (![0, 1].includes(data[split + 1]) || data[split + 2] !== 0 || languageEnd < 0 || translatedEnd < 0) throw new Error('PNG 文本格式不正确');
          const payload = data.subarray(translatedEnd + 1);
          text = (data[split + 1] ? inflateSync(payload, { maxOutputLength: maxText }) : payload).toString('utf8');
        }
        cards.push({ key, text });
      }
    }
    if (!cardChunk) chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new Error('PNG 数据不完整');
  const embedded = cards.find(card => card.key === 'ccv3') ?? cards.find(card => card.key === 'chara');
  if (!embedded) throw new Error('这是一张普通图片，没有内嵌角色卡数据');
  const text = embedded.text.trim();
  const json = jsonCard(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
  // Canonicalize conflicting/older metadata without changing the image pixels.
  const data = Buffer.concat([Buffer.from('chara\0'), Buffer.from(Buffer.from(json).toString('base64'))]);
  const chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  chunks.splice(-1, 0, chunk);
  return { json, png: Buffer.concat([signature, ...chunks]) };
}
