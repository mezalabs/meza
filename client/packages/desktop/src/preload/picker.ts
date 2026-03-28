import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pickerAPI', {
  getSources: () =>
    ipcRenderer.invoke('picker:getSources') as Promise<
      Array<{ id: string; name: string; thumbnail: string }>
    >,
  select: (sourceId: string) => ipcRenderer.send('picker:select', sourceId),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
