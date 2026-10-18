import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chatFilePath } from './archive';
import type { ChatReference } from './types';
const same = (a: ChatReference, b: ChatReference) => a.avatar === b.avatar && a.fileName === b.fileName;
/** Durable backups precede Tavern deletion; an uncommitted index restores missing files after a crash. */
export class ChatDeletion {
  private rows: { chat: ChatReference; existed: boolean }[] = [];
  readonly folder: string;
  constructor(private directory: string, id: string = randomUUID()) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('删除备份标识不正确');
    this.folder = path.join(directory, 'chat-deletion-backups', id);
  }
  async prepare(chats: ChatReference[]) {
    await mkdir(this.folder, { recursive: true });
    for (const [index, chat] of chats.entries()) {
      let existed = true;
      try { await copyFile(chatFilePath(this.directory, chat), path.join(this.folder, `${index}.jsonl`)); }
      catch (cause: any) { if (cause.code !== 'ENOENT') throw cause; existed = false; }
      this.rows.push({ chat, existed });
    }
    const file = path.join(this.folder, 'journal.json');
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, rows: this.rows }), 'utf8'); await rename(`${file}.tmp`, file);
  }
  async remove(remove: (chat: ChatReference) => Promise<void>) { for (const row of this.rows) if (row.existed) await remove(row.chat); }
  async settle(references: ChatReference[]) {
    for (const [index, row] of this.rows.entries()) {
      const target = chatFilePath(this.directory, row.chat);
      if (!row.existed || !references.some(ref => same(ref, row.chat))) continue;
      try { await readFile(target); continue; } catch (cause: any) { if (cause.code !== 'ENOENT') throw cause; }
      const backup = await readFile(path.join(this.folder, `${index}.jsonl`));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(`${target}.friend-restore.tmp`, backup); await rename(`${target}.friend-restore.tmp`, target);
    }
    await unlink(path.join(this.folder, 'journal.json')).catch((cause: any) => { if (cause.code !== 'ENOENT') throw cause; });
  }
  static async recover(directory: string, references: ChatReference[]) {
    const root = path.join(directory, 'chat-deletion-backups');
    const folders = await readdir(root, { withFileTypes: true }).catch((cause: any) => { if (cause.code === 'ENOENT') return []; throw cause; });
    for (const folder of folders) {
      if (!folder.isDirectory() || !/^[a-f0-9-]{36}$/.test(folder.name)) continue;
      const deletion = new ChatDeletion(directory, folder.name);
      let raw: any;
      try { raw = JSON.parse(await readFile(path.join(deletion.folder, 'journal.json'), 'utf8')); } catch (cause: any) { if (cause.code === 'ENOENT') continue; throw cause; }
      if (raw.version !== 1 || !Array.isArray(raw.rows) || raw.rows.some((row: any) => !row || typeof row.existed !== 'boolean' || !row.chat)) throw new Error('聊天删除恢复记录无法读取');
      deletion.rows = raw.rows; await deletion.settle(references);
    }
  }
}
