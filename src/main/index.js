import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

import { listDevices, startRecording, stopRecording } from './audio.js'
import { transcribe, MODEL_NAME } from './transcribe.js'
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
const defaultConfig = { protocolsDir: join(homedir(), 'MeetingProtokolle'), model: MODEL_NAME }

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

  const transcript = await transcribe(wav, { language: 'auto', onLog: log })
  if (!transcript) throw new Error('Transkript ist leer – wurde Audio aufgenommen?')

  const cfg = await loadConfig()
  log('Lese vorhandene Protokolle als Kontext …')
  const notes = await readExistingNotes(cfg.protocolsDir)

  const filename = buildFilename(new Date())
  const content = await summarize({ transcript, notes, filename, onLog: log })

  const path = await saveNote(cfg.protocolsDir, filename, content)
  log(`Protokoll gespeichert: ${path}`)
  return { path, filename, content, transcript }
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

// open the protocols folder inside Obsidian via its URI scheme
ipcMain.handle('folder:openObsidian', async () => {
  const cfg = await loadConfig()
  await mkdir(cfg.protocolsDir, { recursive: true })
  return shell.openExternal(`obsidian://open?path=${encodeURIComponent(cfg.protocolsDir)}`)
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
