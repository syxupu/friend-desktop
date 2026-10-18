import { contextBridge, ipcRenderer } from 'electron';
const listener = (channel: string, callback: (...args: any[]) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
  ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('friend', {
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
