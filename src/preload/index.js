import { contextBridge, ipcRenderer } from 'electron'

// safe bridge between renderer and main process
contextBridge.exposeInMainWorld('api', {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  chooseDir: () => ipcRenderer.invoke('config:chooseDir'),
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  saveNote: (path, content) => ipcRenderer.invoke('note:save', { path, content }),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  openFolderInObsidian: () => ipcRenderer.invoke('folder:openObsidian'),
  onLog: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('job:log', handler)
    return () => ipcRenderer.removeListener('job:log', handler)
  }
})
