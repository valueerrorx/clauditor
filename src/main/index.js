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

import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'

const execFileAsync = promisify(execFile)

import { listDevices, startRecording, stopRecording, measureMaxVolumeDb, convertToWav } from './audio.js'
import { transcribe, MODEL_NAME } from './transcribe.js'
import { diarize } from './diarize.js'
import { summarize } from './summarize.js'
import { readExistingNotes, buildFilename, saveNote } from './notes.js'

// app icon, bundled to out/ by electron-vite at build time
import iconPath from '../assets/clauditor_icon.png?asset'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow = null
let tray = null
let recProc = null
let recFile = null
// true only when the user really wants to quit, lets us trap window close while recording
let isQuitting = false

// small persisted config holding the protocols folder
const configPath = join(app.getPath('userData'), 'config.json')
const defaultConfig = {
  protocolsDir: join(homedir(), 'MeetingProtokolle'),
  model: MODEL_NAME,
  // transcription language: 'auto' detects, otherwise an ISO code like 'de'/'en'
  language: 'de',
  // speaker diarization via WhisperX (needs a HuggingFace token for pyannote)
  diarization: false,
  hfToken: ''
}

const LANGUAGES = ['auto', 'de', 'en']

async function loadConfig() {
  try {
    return { ...defaultConfig, ...JSON.parse(await readFile(configPath, 'utf8')) }
  } catch {
    return { ...defaultConfig }
  }
}

async function saveConfig(cfg) {
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
}

function log(msg) {
  mainWindow?.webContents.send('job:log', msg)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'clauditor',
    icon: iconPath,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  // while recording, closing the window must not quit the app, only hide it to tray
  mainWindow.on('close', (e) => {
    if (recProc && !isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      log('Aufnahme läuft – Fenster minimiert, App bleibt aktiv.')
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow() {
  if (!mainWindow) return createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 })
  tray = new Tray(image)
  tray.setToolTip('clauditor')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'clauditor anzeigen', click: showWindow },
      { type: 'separator' },
      {
        label: 'Beenden',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showWindow)
}

ipcMain.handle('devices:list', () => listDevices())

ipcMain.handle('config:get', () => loadConfig())

// open external links (e.g. setup pages) in the system browser
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url)
  return false
})

ipcMain.handle('config:set', async (_e, patch) => {
  const cfg = await loadConfig()
  // only allow known keys to be patched from the renderer
  const next = { ...cfg }
  if (typeof patch?.diarization === 'boolean') next.diarization = patch.diarization
  if (typeof patch?.hfToken === 'string') next.hfToken = patch.hfToken.trim()
  if (LANGUAGES.includes(patch?.language)) next.language = patch.language
  await saveConfig(next)
  return next
})

ipcMain.handle('config:chooseDir', async () => {
  const cfg = await loadConfig()
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Protokoll-Ordner wählen',
    defaultPath: cfg.protocolsDir,
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return cfg
  cfg.protocolsDir = res.filePaths[0]
  await saveConfig(cfg)
  return cfg
})

ipcMain.handle('record:start', async (_e, { mic, monitor }) => {
  if (recProc) throw new Error('Aufnahme läuft bereits')
  const dir = join(tmpdir(), 'clauditor')
  await mkdir(dir, { recursive: true })
  recFile = join(dir, `rec-${Date.now()}.wav`)
  recProc = startRecording({ mic, monitor, outFile: recFile })
  recProc.on('close', () => { /* handled in stop */ })
  log('Aufnahme gestartet …')
  return { ok: true }
})

ipcMain.handle('record:stop', async () => {
  if (!recProc) throw new Error('Keine aktive Aufnahme')
  const proc = recProc
  const wav = recFile
  recProc = null
  recFile = null

  log('Aufnahme gestoppt, finalisiere Datei …')
  await stopRecording(proc)

  return processAudio(wav)
})

// shared pipeline: transcribe/diarize a 16kHz mono wav, summarize and save it
async function processAudio(wav) {
  const cfg = await loadConfig()
  const diarized = Boolean(cfg.diarization && cfg.hfToken)

  // diarized path uses WhisperX (transcribe + speaker labels), else fast nodejs-whisper
  const language = cfg.language || 'auto'
  const transcript = diarized
    ? await diarize(wav, {
        venvDir: join(app.getPath('userData'), 'whisperx-venv'),
        model: cfg.model,
        hfToken: cfg.hfToken,
        language,
        onLog: log
      })
    : await transcribe(wav, { language, onLog: log })

  // distinguish "no sound" from "audio present but no speech"
  if (!transcript || !transcript.trim()) {
    const maxDb = await measureMaxVolumeDb(wav)
    if (maxDb !== null && maxDb < -50) {
      throw new Error(
        `Audio enthält keinen Ton (Pegel ${maxDb === -Infinity ? '-∞' : maxDb} dB). Bitte Quelle prüfen und sicherstellen, dass sie nicht stummgeschaltet ist.`
      )
    }
    throw new Error('Kein Transkript erkannt – es war Ton vorhanden, aber es wurde keine Sprache erkannt.')
  }

  log('Lese vorhandene Protokolle als Kontext …')
  const notes = await readExistingNotes(cfg.protocolsDir)

  const filename = buildFilename(new Date())
  const content = await summarize({ transcript, notes, filename, diarized, onLog: log })

  const path = await saveNote(cfg.protocolsDir, filename, content)
  log(`Protokoll gespeichert: ${path}`)
  return { path, filename, content, transcript }
}

// import an existing audio file: convert to wav, then run the shared pipeline
ipcMain.handle('import:audio', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Audio-Datei importieren',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'webm', 'mp4', 'mkv', 'mov'] },
      { name: 'Alle Dateien', extensions: ['*'] }
    ]
  })
  if (res.canceled || !res.filePaths[0]) return null

  const source = res.filePaths[0]
  const dir = join(tmpdir(), 'clauditor')
  await mkdir(dir, { recursive: true })
  const wav = join(dir, `import-${Date.now()}.wav`)

  log(`Importiere ${source} …`)
  await convertToWav(source, wav)
  return processAudio(wav)
})

ipcMain.handle('note:save', async (_e, { path, content }) => {
  await writeFile(path, content, 'utf8')
  return { ok: true }
})

// always open the configured protocols folder (never a single file)
ipcMain.handle('folder:open', async () => {
  const cfg = await loadConfig()
  await mkdir(cfg.protocolsDir, { recursive: true })
  return shell.openPath(cfg.protocolsDir)
})

// resolve the obsidian launch command from its registered desktop entry
async function resolveObsidianCommand() {
  // find the .desktop file registered for the obsidian:// scheme
  const { stdout } = await execFileAsync('xdg-mime', ['query', 'default', 'x-scheme-handler/obsidian'])
  const desktopName = stdout.trim()
  if (!desktopName) throw new Error('Kein Obsidian-Handler registriert')

  const dirs = [
    join(homedir(), '.local/share/applications'),
    '/usr/share/applications',
    join(homedir(), '.local/share/flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications'
  ]
  let desktop = null
  for (const dir of dirs) {
    try {
      desktop = await readFile(join(dir, desktopName), 'utf8')
      break
    } catch {}
  }
  if (!desktop) throw new Error(`Desktop-Datei nicht gefunden: ${desktopName}`)

  // take the Exec line and strip desktop field codes (%U, %F, ...)
  const execLine = desktop.match(/^Exec=(.+)$/m)?.[1]
  if (!execLine) throw new Error('Keine Exec-Zeile in der Desktop-Datei')
  const tokens = execLine
    .split(/\s+/)
    .filter((t) => !/^%[a-zA-Z]$/.test(t))
  return { cmd: tokens[0], args: tokens.slice(1) }
}

// strip AppImage runtime vars inherited from the host launcher (e.g. Cursor),
// otherwise the spawned Obsidian AppImage reads the wrong APPDIR/ARGV0 and its
// binfmt-bypass interpreter crashes before starting
function cleanAppImageEnv() {
  const env = { ...process.env }
  const drop = [
    'APPIMAGE', 'APPDIR', 'ARGV0', 'APPRUN', 'OWD',
    'TARGET_APPIMAGE', 'REDIRECT_APPIMAGE', 'DESKTOPINTEGRATION',
    'LD_LIBRARY_PATH', 'LD_PRELOAD', 'PERLLIB',
    'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH'
  ]
  for (const key of drop) delete env[key]
  // remove host-mount segments from list-style vars
  for (const key of ['PATH', 'XDG_DATA_DIRS']) {
    if (!env[key]) continue
    env[key] = env[key].split(':').filter((p) => !p.includes('/.mount_')).join(':')
  }
  return env
}

// register a folder as an Obsidian vault and return its id; Obsidian only opens
// a folder as a vault when it is listed in obsidian.json (the CLI path arg is ignored)
async function ensureObsidianVault(dir) {
  const candidates = [
    join(homedir(), '.config/obsidian/obsidian.json'),
    join(homedir(), '.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json')
  ]
  let path = null
  let cfg = { vaults: {} }
  for (const p of candidates) {
    try {
      cfg = JSON.parse(await readFile(p, 'utf8'))
      path = p
      break
    } catch {}
  }
  if (!path) path = candidates[0] // obsidian never ran yet, use the default location
  if (!cfg.vaults) cfg.vaults = {}

  let id = Object.keys(cfg.vaults).find((k) => cfg.vaults[k].path === dir)
  if (!id) {
    id = randomBytes(8).toString('hex')
    cfg.vaults[id] = { path: dir, ts: Date.now() }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cfg), 'utf8')
  }
  return id
}

// open the protocols folder as a vault in Obsidian
ipcMain.handle('folder:openObsidian', async () => {
  const cfg = await loadConfig()
  await mkdir(cfg.protocolsDir, { recursive: true })
  const vaultId = await ensureObsidianVault(cfg.protocolsDir)
  const { cmd, args } = await resolveObsidianCommand()
  const child = spawn(cmd, [...args, `obsidian://open?vault=${vaultId}`], {
    detached: true,
    stdio: 'ignore',
    env: cleanAppImageEnv()
  })
  child.unref()
  return true
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null) // remove the top menu bar
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// mark a real quit so the close handler stops trapping the window
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
