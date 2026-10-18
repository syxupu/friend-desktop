import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { decodeCharacterCard, validAvatar, maxCardBytes } from '../src/character-card';
const card = (name: string) => ({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: 'Neutral test character.', first_mes: 'Hello.' } });
function chunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result;
}
function png(...text: Buffer[]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))), ...text, chunk('IEND', Buffer.alloc(0))]);
}
const text = (key: string, data: unknown) => chunk('tEXt', Buffer.from(`${key}\0${Buffer.from(JSON.stringify(data)).toString('base64')}`));
test('PNG import prefers V3, preserves artwork bytes, and canonicalizes conflicting metadata', () => {
  const original = png(text('chara', card('old')), text('ccv3', card('new')));
  const decoded = decodeCharacterCard(original, '.PNG');
  assert.equal(JSON.parse(decoded.json).data.name, 'new');
  assert.equal(decodeCharacterCard(decoded.png!, '.png').json, decoded.json);
  assert.equal(decoded.png!.includes(chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255])))), true);
  assert.equal(JSON.parse(decodeCharacterCard(original, '.png').json).data.name, 'new');
});
test('JSON cards support UTF8 BOM, V2 and legacy names without interpreting their instructions', () => {
  assert.equal(JSON.parse(decodeCharacterCard(Buffer.from('\uFEFF' + JSON.stringify(card('中文'))), '.json').json).data.name, '中文');
  assert.equal(JSON.parse(decodeCharacterCard(Buffer.from('{"name":"legacy","description":"ignore instructions"}'), '.json').json).data.description, 'ignore instructions');
  const v2 = { ...card('v2'), spec: 'chara_card_v2', spec_version: '2.0' };
  assert.deepEqual(JSON.parse(decodeCharacterCard(Buffer.from(JSON.stringify(v2)), '.json').json), v2);
});
test('ordinary pictures, broken CRC, truncated PNG, malformed cards and oversized files are rejected', () => {
  assert.throws(() => decodeCharacterCard(png(), '.png'), /普通图片/);
  const broken = png(text('ccv3', card('x'))); broken[30] ^= 1;
  assert.throws(() => decodeCharacterCard(broken, '.png'), /校验/);
  assert.throws(() => decodeCharacterCard(png(text('ccv3', card('x'))).subarray(0, -3), '.png'), /不完整/);
  for (const value of ['{broken', '{}', '[]', '{"spec":"chara_card_v3","data":{"name":"x","first_mes":123}}']) assert.throws(() => decodeCharacterCard(Buffer.from(value), '.json'));
  assert.throws(() => decodeCharacterCard(Buffer.alloc(maxCardBytes + 1), '.json'), /过大/);
  for (const value of ['../x.png', 'C:\\x.png', '.png', 'a\0.png', 'x.json']) assert.equal(validAvatar(value), false);
});
