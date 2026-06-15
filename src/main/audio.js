import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// map pulse source name -> human readable description
async function getDescriptions() {
  const map = new Map()
  try {
    const { stdout } = await execFileAsync('pactl', ['list', 'sources'], { maxBuffer: 1024 * 1024 })
    let name = null
    for (const line of stdout.split('\n')) {
      const n = line.match(/^\s*Name:\s*(.+)$/)
      if (n) { name = n[1].trim(); continue }
      const d = line.match(/^\s*Description:\s*(.+)$/)
      if (d && name) { map.set(name, d[1].trim()); name = null }
    }
  } catch {
    // descriptions are optional, fall back to raw names
  }
  return map
}

// list capture sources split into microphones and output monitors
export async function listDevices() {
  const desc = await getDescriptions()
  const { stdout } = await execFileAsync('pactl', ['list', 'short', 'sources'], { maxBuffer: 1024 * 1024 })

  const mics = []
  const monitors = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    const name = cols[1]
    if (!name) continue
    const entry = { name, label: desc.get(name) || name }
    if (name.endsWith('.monitor')) monitors.push(entry)
    else mics.push(entry)
  }

  let defaultMic = ''
  let defaultMonitor = ''
  try {
    const sink = (await execFileAsync('pactl', ['get-default-sink'])).stdout.trim()
    defaultMonitor = `${sink}.monitor`
    defaultMic = (await execFileAsync('pactl', ['get-default-source'])).stdout.trim()
  } catch {
    // defaults are best-effort
  }

  return { mics, monitors, defaultMic, defaultMonitor }
}

// spawn ffmpeg mixing mic + monitor into a 16kHz mono wav
export function startRecording({ mic, monitor, outFile }) {
  const inputs = []
  const filters = []
  let idx = 0
  if (mic) { inputs.push('-f', 'pulse', '-i', mic); idx++ }
  if (monitor) { inputs.push('-f', 'pulse', '-i', monitor); idx++ }
  if (idx === 0) throw new Error('Keine Audioquelle ausgewählt')

  const args = ['-hide_banner', '-loglevel', 'warning', '-y', ...inputs]
  if (idx === 2) {
    // mix both live sources, async resample keeps them in sync
    args.push('-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,aresample=async=1')
  } else {
    args.push('-af', 'aresample=async=1')
  }
  args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outFile)

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d.toString() })
  proc._getStderr = () => stderr
  return proc
}

// gracefully stop ffmpeg so the wav header is finalized
export function stopRecording(proc) {
  return new Promise((resolve, reject) => {
    if (!proc || proc.exitCode !== null) return resolve()
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 8000)
    proc.on('close', (code) => {
      clearTimeout(timer)
      // ffmpeg exits 0 or 255 when quit via 'q'
      if (code === 0 || code === 255 || code === null) resolve()
      else reject(new Error(`ffmpeg beendet mit Code ${code}: ${proc._getStderr?.() || ''}`))
    })
    try {
      proc.stdin.write('q')
      proc.stdin.end()
    } catch {
      try { proc.kill('SIGINT') } catch {}
    }
  })
}
