import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const [sourcePath, outputDirectory] = process.argv.slice(2);
if (!sourcePath || !outputDirectory) throw new Error('Usage: node extract-character-card.mjs source.png output-directory');
const png = fs.readFileSync(sourcePath);
assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'Invalid PNG signature');
const texts = [];
const chunks = [];
let offset = 8;
let ended = false;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
while (offset < png.length) {
  assert.ok(offset + 12 <= png.length, 'Incomplete PNG chunk');
  const length = png.readUInt32BE(offset);
  assert.ok(offset + length + 12 <= png.length, 'PNG chunk exceeds file bounds');
  const type = png.toString('ascii', offset + 4, offset + 8);
  const data = png.subarray(offset + 8, offset + 8 + length);
  assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length), `CRC mismatch: ${type}`);
  chunks.push({ type, length });
  if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
    const separator = data.indexOf(0);
    assert.ok(separator >= 0, 'Missing PNG text keyword');
    const keyword = data.toString('latin1', 0, separator);
    let value;
    if (type === 'tEXt') value = data.subarray(separator + 1).toString('latin1');
    if (type === 'zTXt') {
      assert.equal(data[separator + 1], 0, 'Unknown PNG compression method');
      value = zlib.inflateSync(data.subarray(separator + 2), { maxOutputLength: 16 * 1024 * 1024 }).toString('latin1');
    }
    if (type === 'iTXt') {
      const compressed = data[separator + 1];
      assert.ok(compressed === 0 || compressed === 1, 'Invalid iTXt compression flag');
      assert.equal(data[separator + 2], 0, 'Unknown iTXt compression method');
      const languageEnd = data.indexOf(0, separator + 3);
      const translatedEnd = data.indexOf(0, languageEnd + 1);
      assert.ok(languageEnd >= 0 && translatedEnd >= 0, 'Invalid iTXt headers');
      const payload = data.subarray(translatedEnd + 1);
      value = (compressed ? zlib.inflateSync(payload, { maxOutputLength: 16 * 1024 * 1024 }) : payload).toString('utf8');
    }
    texts.push({ keyword, value });
  }
  offset += length + 12;
  if (type === 'IEND') { ended = true; break; }
}
assert.ok(ended, 'Missing PNG IEND');
const candidates = texts.filter(item => ['chara', 'ccv3'].includes(item.keyword));
assert.ok(candidates.length, 'No embedded chara or ccv3 character card found');
candidates.sort((a, b) => (a.keyword === 'ccv3' ? 0 : 1) - (b.keyword === 'ccv3' ? 0 : 1));
const baseName = path.basename(sourcePath, path.extname(sourcePath));
// Prefer the embedded V3 entry and export a single canonical card, without merging payloads.
const decodedCards = candidates.slice(0, 1).map((item, index) => {
  const encoded = item.value.trim();
  const raw = encoded.startsWith('{') ? encoded : Buffer.from(encoded, 'base64').toString('utf8');
  const card = JSON.parse(raw);
  assert.ok(card && typeof card === 'object' && !Array.isArray(card), 'Invalid card JSON');
  const filename = index === 0 ? `${baseName}.json` : `${baseName}.${item.keyword}.${index}.json`;
  return { keyword: item.keyword, card, raw, output: path.resolve(outputDirectory, filename) };
});
for (const item of decodedCards) assert.ok(!fs.existsSync(item.output), `Output already exists: ${item.output}`);
fs.mkdirSync(outputDirectory, { recursive: true });
for (const item of decodedCards) {
  fs.writeFileSync(item.output, JSON.stringify(item.card, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(item.output, 'utf8'))) === JSON.stringify(item.card), 'Export differs from embedded data');
}
console.log(JSON.stringify({ source: path.resolve(sourcePath), chunks, cards: decodedCards.map(({ keyword, card, raw, output }) => {
  const data = card.data ?? card;
  return { keyword, output, decodedBytes: Buffer.byteLength(raw), spec: card.spec ?? 'legacy', specVersion: card.spec_version ?? null,
    name: data.name ?? null, fields: Object.keys(data), descriptionCharacters: data.description?.length ?? 0,
    firstMessageCharacters: data.first_mes?.length ?? 0, alternateGreetings: data.alternate_greetings?.length ?? 0,
    lorebookEntries: data.character_book?.entries?.length ?? 0 };
}) }, null, 2));
