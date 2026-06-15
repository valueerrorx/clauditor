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

import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { tmpdir } from 'node:os'

// whisperx needs a compatible python; system python may be too new, so we let
// uv provision a pinned interpreter automatically
const PINNED_PYTHON = '3.12'

// strip AppImage runtime vars inherited from the host launcher (e.g. Cursor),
// so the python/torch process does not pick up the wrong shared libraries
function cleanEnv() {
  const env = { ...process.env }
  const drop = [
    'APPIMAGE', 'APPDIR', 'ARGV0', 'APPRUN', 'OWD',
    'TARGET_APPIMAGE', 'REDIRECT_APPIMAGE', 'DESKTOPINTEGRATION',
    'LD_LIBRARY_PATH', 'LD_PRELOAD', 'PERLLIB',
    'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH'
  ]
  for (const key of drop) delete env[key]
  for (const key of ['PATH', 'XDG_DATA_DIRS']) {
    if (!env[key]) continue
    env[key] = env[key].split(':').filter((p) => !p.includes('/.mount_')).join(':')
  }
  return env
}

// run a command, stream its output line by line to onLog, resolve on exit 0
function run(cmd, args, { env, onLog, label }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const pipe = (buf) => {
      const text = buf.toString()
      tail = (tail + text).slice(-4000)
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t) onLog?.(`${label}: ${t}`)
      }
    }
    proc.stdout.on('data', pipe)
    proc.stderr.on('data', pipe)
    proc.on('error', (e) => reject(new Error(`${cmd} konnte nicht gestartet werden: ${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} beendet mit Code ${code}: ${tail.trim()}`))
    })
  })
}

// ensure an isolated venv with whisperx exists, creating it via uv on first use
async function ensureWhisperxEnv(venvDir, onLog) {
  const env = cleanEnv()
  const whisperxBin = join(venvDir, 'bin', 'whisperx')
  try {
    await access(whisperxBin)
    return { whisperxBin, env }
  } catch {
    // not installed yet, bootstrap below
  }

  onLog?.('Richte WhisperX einmalig ein (uv lädt Python + Abhängigkeiten, kann einige Minuten dauern) …')
  await rm(venvDir, { recursive: true, force: true })
  await mkdir(venvDir, { recursive: true })

  // uv downloads the pinned python automatically if it is missing
  await run('uv', ['venv', '--python', PINNED_PYTHON, venvDir], { env, onLog, label: 'uv venv' })
  await run('uv', ['pip', 'install', '--python', join(venvDir, 'bin', 'python'), 'whisperx'], {
    env,
    onLog,
    label: 'uv pip'
  })

  await access(whisperxBin)
  onLog?.('WhisperX-Einrichtung abgeschlossen.')
  return { whisperxBin, env }
}

// group consecutive same-speaker segments into readable speaker-labelled lines
function segmentsToTranscript(segments) {
  const lines = []
  let current = null
  for (const seg of segments) {
    const speaker = seg.speaker || 'SPRECHER_?'
    const text = (seg.text || '').trim()
    if (!text) continue
    if (current && current.speaker === speaker) {
      current.text += ` ${text}`
    } else {
      current = { speaker, text }
      lines.push(current)
    }
  }
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n')
}

// transcribe + diarize a wav with WhisperX, returning a speaker-labelled transcript
export async function diarize(wavFile, { venvDir, model = 'small', hfToken, language = 'auto', onLog } = {}) {
  if (!hfToken) throw new Error('Kein HuggingFace-Token gesetzt (für die Sprechererkennung erforderlich)')

  const { whisperxBin, env } = await ensureWhisperxEnv(venvDir, onLog)

  const outDir = join(tmpdir(), 'clauditor', 'whisperx')
  await mkdir(outDir, { recursive: true })

  const args = [
    wavFile,
    '--model', model,
    '--diarize',
    '--hf_token', hfToken,
    '--device', 'cpu',
    '--compute_type', 'int8',
    '--output_format', 'json',
    '--output_dir', outDir
  ]
  // only force a language when explicitly chosen, otherwise let whisperx detect
  if (language && language !== 'auto') args.push('--language', language)

  onLog?.('Transkribiere + erkenne Sprecher mit WhisperX …')
  await run(whisperxBin, args, { env: { ...env, HF_TOKEN: hfToken }, onLog, label: 'whisperx' })

  const jsonPath = join(outDir, `${basename(wavFile, extname(wavFile))}.json`)
  const result = JSON.parse(await readFile(jsonPath, 'utf8'))
  // may be empty (e.g. silent audio); the caller decides how to report that
  return segmentsToTranscript(result.segments || [])
}
