<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { marked } from 'marked'

marked.setOptions({ breaks: true, gfm: true })

const mics = ref([])
const monitors = ref([])
const selectedMic = ref('')
const selectedMonitor = ref('')
const protocolsDir = ref('')
const model = ref('')

const recording = ref(false)
const busy = ref(false)
const elapsed = ref(0)
const logs = ref([])
const result = ref(null)
const error = ref('')

const activeTab = ref('preview')
const editContent = ref('')
const saving = ref(false)

let timer = null
let unsubscribe = null

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

function pushLog(msg) {
  logs.value.push({ t: new Date().toLocaleTimeString(), msg })
}

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
    error.value = e.message
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
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function openFolder() {
  window.api.openFolder()
}

function openFolderInObsidian() {
  window.api.openFolderInObsidian()
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
      <div class="state">{{ status }}<span v-if="recording" class="timer">{{ elapsedLabel }}</span></div>
    </header>

    <section class="controls">
      <div class="row">
        <label>
          <span>Mikrofon</span>
          <select v-model="selectedMic" :disabled="recording || busy">
            <option v-for="m in mics" :key="m.name" :value="m.name">{{ m.label }}</option>
          </select>
        </label>
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

      <div class="actions">
        <button v-if="!recording" class="btn-primary big" @click="start" :disabled="busy">● Aufnahme starten</button>
        <button v-else class="btn-danger big" @click="stop">■ Stoppen & Zusammenfassen</button>
        <span class="model">Modell: <code>{{ model }}</code></span>
      </div>
    </section>

    <section class="panels">
      <div class="panel log">
        <h2>Status</h2>
        <p v-if="error" class="error">{{ error }}</p>
        <ul>
          <li v-for="(l, i) in logs" :key="i"><span class="time">{{ l.t }}</span>{{ l.msg }}</li>
          <li v-if="!logs.length" class="muted">Noch keine Aktivität.</li>
        </ul>
      </div>

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

.controls { padding: 18px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
.row { display: flex; gap: 16px; margin-bottom: 14px; }
.row label { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.row label span { color: var(--muted); font-size: 12px; }
.row.dir { align-items: flex-end; }
.grow { flex: 1; }
.input-group { display: flex; }
.input-group .dirbox {
  flex: 1; border-radius: 8px 0 0 8px; border-right: none;
}
.input-group .ig-btn { border-radius: 0 8px 8px 0; white-space: nowrap; }
.dirbox { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.actions { display: flex; align-items: center; gap: 16px; }
.big { padding: 12px 22px; font-size: 15px; font-weight: 600; }
.model { color: var(--muted); }
.model code { color: var(--text); }

.panels { flex: 1; display: grid; grid-template-columns: 320px 1fr; gap: 0; overflow: hidden; }
.panel { padding: 16px 20px; overflow: auto; }
.panel.log { border-right: 1px solid var(--border); background: var(--bg); }
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
