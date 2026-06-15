// clauditor - records mic + system audio, transcribes offline and summarizes with Claude
// Copyright (C) 2026 Thomas Weissel <valueerror@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later version.
// This program is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU General Public License for more details.
// You should have received a copy of the GNU General Public License along with
// this program. If not, see <https://www.gnu.org/licenses/>.

import { contextBridge, ipcRenderer } from 'electron'

// safe bridge between renderer and main process
contextBridge.exposeInMainWorld('api', {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  chooseDir: () => ipcRenderer.invoke('config:chooseDir'),
  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: () => ipcRenderer.invoke('record:stop'),
  importAudio: () => ipcRenderer.invoke('import:audio'),
  saveNote: (path, content) => ipcRenderer.invoke('note:save', { path, content }),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  openFolderInObsidian: () => ipcRenderer.invoke('folder:openObsidian'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onLog: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('job:log', handler)
    return () => ipcRenderer.removeListener('job:log', handler)
  }
})
