import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('friendTavern', {
  report: (data: unknown) => ipcRenderer.send('tavern:event', data),
});
