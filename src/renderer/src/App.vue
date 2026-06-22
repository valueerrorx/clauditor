<!--
  clauditor - records mic + system audio, transcribes offline and summarizes with Claude
  Copyright (C) 2026 Thomas Weissel <valueerror@gmail.com>
  SPDX-License-Identifier: GPL-3.0-or-later

  This program is free software: you can redistribute it and/or modify it under
  the terms of the GNU General Public License as published by the Free Software
  Foundation, either version 3 of the License, or (at your option) any later version.
  This program is distributed in the hope that it will be useful, but WITHOUT ANY
  WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
  PARTICULAR PURPOSE. See the GNU General Public License for more details.
  You should have received a copy of the GNU General Public License along with
  this program. If not, see <https://www.gnu.org/licenses/>.
-->
<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { marked } from 'marked'
import clauditorIcon from '../../assets/clauditor_icon_big.png'

marked.setOptions({ breaks: true, gfm: true })

const mics = ref([])
const monitors = ref([])
const selectedMic = ref('')
const selectedMonitor = ref('')
const protocolsDir = ref('')
const model = ref('')
const models = ref([])
const language = ref('de')
const diarization = ref(false)
const hfToken = ref('')

const recording = ref(false)
const busy = ref(false)
const elapsed = ref(0)
const procElapsed = ref(0)
const logs = ref([])
const result = ref(null)
const error = ref('')

const activeTab = ref('preview')
const editContent = ref('')
const saving = ref(false)

// scroll container of the status log, kept pinned to the bottom on new entries
const logEl = ref(null)

let timer = null
let procTimer = null
let unsubscribe = null

// width of the resizable left status panel
const leftWidth = ref(420)
const panelStyle = computed(() => ({ gridTemplateColumns: `${leftWidth.value}px 6px 1fr` }))

function startDrag(e) {
  const panelsEl = e.currentTarget.parentElement
  const rect = panelsEl.getBoundingClientRect()
  const onMove = (ev) => {
    const w = ev.clientX - rect.left
    // keep both sides usable
    leftWidth.value = Math.max(220, Math.min(w, rect.width - 360))
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// render the (possibly edited) markdown to html for the preview tab
const renderedHtml = computed(() => (result.value ? marked.parse(editContent.value) : ''))
const dirty = computed(() => result.value && editContent.value !== result.value.content)

// reset editor + tab whenever a new protocol arrives
watch(result, (r) => {
  editContent.value = r?.content ?? ''
  activeTab.value = 'preview'
})

async function saveNote() {
  if (!result.value || saving.value) return
  saving.value = true
  try {
    await window.api.saveNote(result.value.path, editContent.value)
    result.value.content = editContent.value
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

const status = computed(() => {
  if (recording.value) return 'Aufnahme läuft'
  if (busy.value) return 'Verarbeite …'
  return 'Bereit'
})

const elapsedLabel = computed(() => {
  const m = String(Math.floor(elapsed.value / 60)).padStart(2, '0')
  const s = String(elapsed.value % 60).padStart(2, '0')
  return `${m}:${s}`
})

const procElapsedLabel = computed(() => {
  const m = String(Math.floor(procElapsed.value / 60)).padStart(2, '0')
  const s = String(procElapsed.value % 60).padStart(2, '0')
  return `${m}:${s}`
})

// run a 1s ticker while processing so the UI proves it is still alive
watch(busy, (v) => {
  clearInterval(procTimer)
  if (v) {
    procElapsed.value = 0
    procTimer = setInterval(() => { procElapsed.value++ }, 1000)
  }
})

function pushLog(msg) {
  logs.value.push({ t: new Date().toLocaleTimeString(), msg })
}

// surface errors both in the banner and the visible log stream
function reportError(message) {
  error.value = message
  pushLog(`Fehler: ${message}`)
}

// always keep the status log scrolled to the newest entry
watch(() => logs.value.length, async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

async function loadDevices() {
  const d = await window.api.listDevices()
  mics.value = d.mics
  monitors.value = d.monitors
  selectedMic.value = d.defaultMic || d.mics[0]?.name || ''
  selectedMonitor.value = d.defaultMonitor || d.monitors[0]?.name || ''
}

async function loadConfig() {
  const cfg = await window.api.getConfig()
  protocolsDir.value = cfg.protocolsDir
  model.value = cfg.model
  models.value = cfg.models
  language.value = cfg.language
  diarization.value = cfg.diarization
  hfToken.value = cfg.hfToken
}

async function saveLanguage() {
  try {
    await window.api.setConfig({ language: language.value })
  } catch (e) {
    error.value = e.message
  }
}

// persist the selected whisper model on change
async function saveModel() {
  try {
    await window.api.setConfig({ model: model.value })
  } catch (e) {
    error.value = e.message
  }
}

// persist diarization settings on change
async function saveDiarization() {
  try {
    await window.api.setConfig({ diarization: diarization.value, hfToken: hfToken.value })
  } catch (e) {
    error.value = e.message
  }
}

async function chooseDir() {
  const cfg = await window.api.chooseDir()
  protocolsDir.value = cfg.protocolsDir
}

async function start() {
  error.value = ''
  result.value = null
  logs.value = []
  try {
    await window.api.startRecording({ mic: selectedMic.value, monitor: selectedMonitor.value })
    recording.value = true
    elapsed.value = 0
    timer = setInterval(() => { elapsed.value++ }, 1000)
  } catch (e) {
    reportError(e.message)
  }
}

async function stop() {
  if (!recording.value) return
  recording.value = false
  busy.value = true
  clearInterval(timer)
  try {
    result.value = await window.api.stopRecording()
  } catch (e) {
    reportError(e.message)
  } finally {
    busy.value = false
  }
}

async function importAudio() {
  if (recording.value || busy.value) return
  error.value = ''
  result.value = null
  logs.value = []
  busy.value = true
  try {
    // null means the file dialog was cancelled
    const r = await window.api.importAudio()
    if (r) result.value = r
  } catch (e) {
    reportError(e.message)
  } finally {
    busy.value = false
  }
}

function openFolder() {
  window.api.openFolder()
}

async function openFolderInObsidian() {
  try {
    await window.api.openFolderInObsidian()
  } catch (e) {
    error.value = e.message
  }
}

function openExternal(url) {
  window.api.openExternal(url)
}

onMounted(async () => {
  unsubscribe = window.api.onLog(pushLog)
  try {
    await Promise.all([loadDevices(), loadConfig()])
  } catch (e) {
    error.value = e.message
  }
})

onBeforeUnmount(() => {
  clearInterval(timer)
  clearInterval(procTimer)
  unsubscribe?.()
})
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="{ live: recording, work: busy }"></span>
        <h1>clauditor - meeting assistant</h1>
      </div>
      <div class="state">
        <span v-if="busy" class="spinner"></span>
        {{ status }}
        <span v-if="recording" class="timer">{{ elapsedLabel }}</span>
        <span v-else-if="busy" class="timer">{{ procElapsedLabel }}</span>
      </div>
    </header>

    <section class="controls">
      <div class="row sources">
        <label>
          <span>Mikrofon</span>
          <select v-model="selectedMic" :disabled="recording || busy">
            <option v-for="m in mics" :key="m.name" :value="m.name">{{ m.label }}</option>
          </select>
        </label>
        <div class="source-logo-slot">
          <img class="source-logo" :src="clauditorIcon" alt="clauditor" />
        </div>
        <label>
          <span>System-Ton (Monitor)</span>
          <select v-model="selectedMonitor" :disabled="recording || busy">
            <option value="">— kein System-Ton —</option>
            <option v-for="m in monitors" :key="m.name" :value="m.name">{{ m.label }}</option>
          </select>
        </label>
      </div>

      <div class="row dir">
        <label class="grow">
          <span>Protokoll-Ordner</span>
          <div class="input-group">
            <div class="dirbox">{{ protocolsDir || '—' }}</div>
            <button class="ig-btn" @click="chooseDir" :disabled="recording || busy">Ändern…</button>
          </div>
        </label>
        <button @click="openFolder">Ordner öffnen</button>
        <button @click="openFolderInObsidian">Ordner in Obsidian öffnen</button>
      </div>

      <div class="row diarize">
        <label class="check">
          <input type="checkbox" v-model="diarization" @change="saveDiarization" :disabled="recording || busy" />
          <span>Sprechererkennung (WhisperX)</span>
        </label>
        <label class="grow token" v-if="diarization">
          <span>HuggingFace-Token (für Diarisierung)</span>
          <input
            type="password"
            v-model="hfToken"
            @change="saveDiarization"
            :disabled="recording || busy"
            placeholder="hf_…"
          />
        </label>
      </div>
      <p class="hint" v-if="diarization && !hfToken">
        Einmalig nötig:
        1.
        <a href="#" @click.prevent="openExternal('https://huggingface.co/pyannote/speaker-diarization-community-1')">
          Lizenz von pyannote/speaker-diarization-community-1 akzeptieren
        </a>,
        2.
        <a href="#" @click.prevent="openExternal('https://huggingface.co/settings/tokens')">
          Read-Token erstellen
        </a>
        und oben einfügen. WhisperX wird beim ersten Lauf automatisch installiert (über uv).
      </p>

      <div class="actions">
        <button v-if="!recording" class="btn-primary big" @click="start" :disabled="busy">● Aufnahme starten</button>
        <button v-else class="btn-danger big" @click="stop">■ Stoppen & Zusammenfassen</button>
        <button class="btn-ghost big" @click="importAudio" :disabled="recording || busy">⇪ Audio importieren</button>
        <span class="spacer"></span>
        <label class="lang">
          <span>Sprache</span>
          <select v-model="language" @change="saveLanguage" :disabled="recording || busy">
            <option value="auto">Automatisch</option>
            <option value="de">Deutsch</option>
            <option value="en">Englisch</option>
          </select>
        </label>
        <label class="model">
          <span>Modell</span>
          <select v-model="model" @change="saveModel" :disabled="recording || busy">
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </div>
    </section>

    <section class="panels" :style="panelStyle">
      <div class="panel log" ref="logEl">
        <h2>Status</h2>
        <p v-if="error" class="error">{{ error }}</p>
        <ul>
          <li v-for="(l, i) in logs" :key="i"><span class="time">{{ l.t }}</span>{{ l.msg }}</li>
          <li v-if="busy" class="busy-row"><span class="spinner"></span>Verarbeite … {{ procElapsedLabel }}</li>
          <li v-if="!logs.length && !busy" class="muted">Noch keine Aktivität.</li>
        </ul>
      </div>

      <div class="splitter" @mousedown="startDrag" title="Ziehen zum Verbreitern"></div>

      <div class="panel result" v-if="result">
        <div class="result-head">
          <h2>{{ result.filename }}</h2>
        </div>

        <div class="tabs">
          <button class="tab" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'">Vorschau</button>
          <button class="tab" :class="{ active: activeTab === 'edit' }" @click="activeTab = 'edit'">Bearbeiten</button>
        </div>

        <div v-show="activeTab === 'preview'" class="markdown-body" v-html="renderedHtml"></div>

        <div v-show="activeTab === 'edit'">
          <textarea class="editor" v-model="editContent" spellcheck="false"></textarea>
          <div class="editor-footer">
            <span v-if="dirty" class="dirty">● nicht gespeichert</span>
            <button class="btn-primary" @click="saveNote" :disabled="!dirty || saving">{{ saving ? 'Speichere…' : 'Speichern' }}</button>
          </div>
        </div>

        <details>
          <summary>Roh-Transkript anzeigen</summary>
          <pre class="transcript">{{ result.transcript }}</pre>
        </details>
      </div>
    </section>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100%; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--panel);
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand h1 { font-size: 16px; margin: 0; font-weight: 600; line-height: 1; }
.dot { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); }
.dot.live { background: var(--danger); animation: pulse 1.2s infinite; }
.dot.work { background: var(--accent); animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
.state { color: var(--muted); display: flex; align-items: center; gap: 10px; }
.timer { font-variant-numeric: tabular-nums; color: var(--text); font-weight: 600; }
.spinner {
  display: inline-block; width: 14px; height: 14px; flex: 0 0 auto;
  border: 2px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.busy-row { display: flex; align-items: center; gap: 8px; color: var(--accent); font-variant-numeric: tabular-nums; }

.controls { padding: 18px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
.row { display: flex; gap: 16px; margin-bottom: 14px; }
.row label { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.row label span { color: var(--muted); font-size: 12px; }
.row.sources { align-items: flex-end; }
/* reserves horizontal space between the inputs so they keep a margin to the logo */
.source-logo-slot { flex: 0 0 auto; align-self: stretch; position: relative; width: 109px; }
/* centered inside its slot; overflows vertically without growing the row */
.source-logo {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, calc(-50% + 8px));
  height: 109px; width: auto; object-fit: contain; pointer-events: none;
}
.row.dir { align-items: flex-end; }
.row.diarize { flex-direction: column; align-items: flex-start; gap: 12px; }
.row.diarize .token { width: 100%; flex-direction: row; align-items: center; gap: 10px; }
.row.diarize .token span { white-space: nowrap; }
.row.diarize .token input { flex: 0 0 auto; width: 40ch; }
.check { flex: 0 0 auto; flex-direction: row !important; align-items: center; gap: 8px; cursor: pointer; }
.check input { width: 16px; height: 16px; }
.check span { color: var(--text) !important; font-size: 14px !important; }
.hint { margin: -6px 0 14px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.hint code { color: var(--text); }
.hint a { color: var(--accent); text-decoration: underline; cursor: pointer; }
.grow { flex: 1; }
.input-group { display: flex; }
.input-group .dirbox {
  flex: 1; border-radius: 8px 0 0 8px; border-right: none;
}
.input-group .ig-btn { border-radius: 0 8px 8px 0; white-space: nowrap; }
.dirbox { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.actions { display: flex; align-items: center; gap: 16px; }
.actions .spacer { flex: 1; }
.actions .lang { display: flex; flex-direction: row; align-items: center; gap: 8px; }
.actions .lang span { color: var(--muted); font-size: 13px; }
.actions .lang select { width: auto; }
.big { padding: 12px 22px; font-size: 15px; font-weight: 600; }
.actions .model { display: flex; flex-direction: row; align-items: center; gap: 8px; }
.actions .model span { color: var(--muted); font-size: 13px; }
.actions .model select { width: auto; }
.btn-ghost { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; }
.btn-ghost:hover:not(:disabled) { border-color: var(--accent); }

.panels { flex: 1; display: grid; grid-template-columns: 420px 6px 1fr; gap: 0; overflow: hidden; min-height: 0; }
.panel { padding: 16px 20px; overflow: auto; }
.panel.log { background: var(--bg); }
.splitter { cursor: col-resize; background: var(--border); transition: background .15s; }
.splitter:hover { background: var(--accent); }
.panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 12px; }
.log ul { list-style: none; margin: 0; padding: 0; }
.log li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.log .time { color: var(--muted); margin-right: 8px; font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.error { color: var(--danger); background: rgba(255,91,110,.1); padding: 10px; border-radius: 8px; }

.result-head { display: flex; align-items: center; justify-content: space-between; }

.tabs { display: flex; align-items: center; gap: 6px; margin: 14px 0 10px; border-bottom: 1px solid var(--border); }
.tab {
  border: none; background: transparent; color: var(--muted); border-radius: 0;
  padding: 8px 14px; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover:not(:disabled) { filter: none; color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.editor-footer { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 10px; }
.dirty { color: var(--danger); font-size: 12px; }

.markdown-body {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 22px; line-height: 1.6;
}
.markdown-body :deep(h1) { font-size: 22px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.markdown-body :deep(h2) { font-size: 18px; margin-top: 22px; }
.markdown-body :deep(h3) { font-size: 15px; color: var(--muted); text-transform: none; letter-spacing: 0; }
.markdown-body :deep(a) { color: var(--accent); }
.markdown-body :deep(code) { background: var(--panel-2); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
.markdown-body :deep(pre) { background: var(--panel-2); padding: 14px; border-radius: 8px; overflow: auto; }
.markdown-body :deep(pre code) { background: none; padding: 0; }
.markdown-body :deep(blockquote) { border-left: 3px solid var(--border); margin: 0; padding-left: 14px; color: var(--muted); }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 22px; }
.markdown-body :deep(li) { margin: 4px 0; }
.markdown-body :deep(table) { border-collapse: collapse; }
.markdown-body :deep(th), .markdown-body :deep(td) { border: 1px solid var(--border); padding: 6px 10px; }
.markdown-body :deep(input[type=checkbox]) { margin-right: 6px; }
.markdown-body :deep(hr) { border: none; border-top: 1px solid var(--border); }

.editor {
  width: 100%; min-height: 380px; resize: vertical; font: 13px/1.6 ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px; tab-size: 2;
}
.editor:focus { outline: none; border-color: var(--accent); }

.transcript {
  white-space: pre-wrap; word-break: break-word; background: var(--panel);
  border: 1px solid var(--border); border-radius: 10px; padding: 16px; line-height: 1.55;
  color: var(--muted); margin-top: 8px;
}
details { margin-top: 14px; }
summary { cursor: pointer; color: var(--accent); }
</style>
