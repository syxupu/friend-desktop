import { revisionOf } from './companions';
import type { LoreEntry } from './types';
export interface LinkedWorld { name: string; data: any }
export function loreDocument(data: any, world?: LinkedWorld | null) {
  const embedded = Array.isArray(data.character_book?.entries) ? data.character_book.entries : [];
  const used = new Set<string>();
  const lore: LoreEntry[] = embedded.map((entry: any, index: number) => {
    const uid = String(entry.id ?? index), linked = world?.data?.entries?.[uid];
    const paired = linked && linked.content === entry.content && JSON.stringify(linked.key ?? []) === JSON.stringify(entry.keys ?? []);
    if (paired) used.add(uid);
    return { key: `e:${index}`, title: String(entry.name || entry.comment || '未命名条目'), content: String(entry.content ?? ''), constant: !!entry.constant, enabled: entry.enabled !== false, source: paired ? 'both' : 'embedded' };
  });
  for (const [uid, entry] of Object.entries<any>(world?.data?.entries ?? {})) if (!used.has(uid)) lore.push({ key: `w:${uid}`, title: String(entry.comment || '未命名条目'), content: String(entry.content ?? ''), constant: !!entry.constant, enabled: !entry.disable, source: 'world' });
  return { lore, loreRevision: revisionOf({ book: data.character_book ?? null, world: world ?? null }) };
}
export function removeLore(data: any, world: LinkedWorld | null | undefined, key: string) {
  const doc = loreDocument(data, world), target = doc.lore.find(entry => entry.key === key);
  if (!target) throw new Error('角色书条目已不存在，请重新读取');
  const book = data.character_book ? structuredClone(data.character_book) : undefined;
  let uid: string | undefined;
  if (key.startsWith('e:')) {
    const index = Number(key.slice(2)), entry = book.entries[index];
    if (target.source === 'both') uid = String(entry.id ?? index);
    // Keep implicit IDs stable after removing an earlier entry.
    book.entries = book.entries.map((entry: any, i: number) => ({ ...entry, id: entry.id ?? i })).filter((_entry: any, i: number) => i !== index);
  } else uid = key.slice(2);
  const worldCopy = uid !== undefined && world ? structuredClone(world.data) : undefined;
  if (worldCopy) {
    delete worldCopy.entries[uid!];
    if (Array.isArray(worldCopy.originalData?.entries)) worldCopy.originalData.entries = worldCopy.originalData.entries.filter((entry: any, i: number) => String(entry.id ?? i) !== uid);
  }
  return { book, worldCopy };
}
