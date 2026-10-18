import { contextBridge, ipcRenderer } from 'electron';
const listener = (channel: string, callback: (...args: any[]) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
  ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('friend', {
  deleteRecord: (taskId: string, segmentId?: string) => ipcRenderer.invoke('friend:archive-delete', taskId, segmentId),
  deleteLore: (avatar: string, revision: string, key: string) => ipcRenderer.invoke('friend:lore-delete', avatar, revision, key),
  listModels: (query: unknown) => ipcRenderer.invoke('friend:models', query),
  layoutPet: (height: number) => ipcRenderer.send('friend:pet-layout', height),
  onOpenSettings: (callback: (toggle: boolean) => void) => listener('friend:open-settings', callback),
  getCharacter: (avatar: string) => ipcRenderer.invoke('friend:character-get', avatar),
  saveCharacter: (input: unknown) => ipcRenderer.invoke('friend:character-save', input),
  copyCharacter: (avatar: string, revision: string) => ipcRenderer.invoke('friend:character-copy', avatar, revision),
  saveCompanionPreferences: (avatar: string, revision: string, preferences: unknown) => ipcRenderer.invoke('friend:companion-save', avatar, revision, preferences),
  newCharacterChat: () => ipcRenderer.invoke('friend:character-chat'),
  listCharacters: () => ipcRenderer.invoke('friend:characters'),
  importCharacter: () => ipcRenderer.invoke('friend:character-import'),
  selectCharacter: (avatar: string) => ipcRenderer.invoke('friend:character-select', avatar),
  getState: () => ipcRenderer.invoke('friend:get'),
  send: (text: string) => ipcRenderer.invoke('friend:send', text),
  pinChat: (pinned: boolean) => ipcRenderer.invoke('friend:pin', pinned),
  changeMessage: (change: unknown) => ipcRenderer.invoke('friend:message', change),
  listTasks: () => ipcRenderer.invoke('friend:archive-list'),
  getTask: (id: string) => ipcRenderer.invoke('friend:archive-task', id),
  getSegment: (taskId: string, segmentId: string) => ipcRenderer.invoke('friend:archive-segment', taskId, segmentId),
  control: (action: string, topic?: string) => ipcRenderer.invoke('friend:control', action, topic),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('friend:settings', patch),
  action: (action: string) => ipcRenderer.invoke('friend:action', action),
  movePet: (x: number, y: number) => ipcRenderer.send('friend:move', x, y),
  audioStatus: (id: string, playing: boolean) => ipcRenderer.send('friend:audio-status', id, playing),
  onState: (callback: (state: unknown) => void) => listener('friend:state', callback),
  onAudio: (callback: (data: unknown) => void) => listener('friend:audio', callback),
});
