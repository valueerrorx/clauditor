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
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'
import { cleanEnv, modelsDir, whisperBinary } from './runtime.js'

// whisper.cpp ggml models (name -> file), hosted by the whisper.cpp project
const MODEL_FILES = {
  tiny: 'ggml-tiny.bin',
  'tiny.en': 'ggml-tiny.en.bin',
  base: 'ggml-base.bin',
  'base.en': 'ggml-base.en.bin',
  small: 'ggml-small.bin',
  'small.en': 'ggml-small.en.bin',
  medium: 'ggml-medium.bin',
  'medium.en': 'ggml-medium.en.bin',
  'large-v1': 'ggml-large-v1.bin',
  large: 'ggml-large-v3.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin'
}
export const MODELS = Object.keys(MODEL_FILES)
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

// whisper model can be overridden, defaults to a balanced offline model
export const MODEL_NAME = process.env.CLAUDITOR_MODEL || 'small'

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// dev only: reuse a model nodejs-whisper already downloaded into node_modules
function legacyModelPath(file) {
  if (app.isPackaged) return null
  return join(app.getAppPath(), 'node_modules/nodejs-whisper/cpp/whisper.cpp/models', file)
}

// return a local path to the model, downloading it on first use
export async function ensureModel(model, onLog) {
  const file = MODEL_FILES[model]
  if (!file) throw new Error(`Unbekanntes Modell: ${model}`)

  const dir = modelsDir()
  const target = join(dir, file)
  if (await exists(target)) return target
  const legacy = legacyModelPath(file)
  if (legacy && (await exists(legacy))) return legacy

  await mkdir(dir, { recursive: true })
  const part = `${target}.part`
  onLog?.(`Lade Modell "${model}" herunter (einmalig) …`)
  const res = await fetch(MODEL_URL + file)
  if (!res.ok || !res.body) throw new Error(`Modell-Download fehlgeschlagen: HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || 0
  let done = 0
  let lastPct = -1
  const out = await open(part, 'w')
  try {
    // single consumer loop: write each chunk in order, report progress in 10% steps
    for await (const chunk of res.body) {
      await out.write(chunk)
      done += chunk.length
      const pct = total ? Math.floor((done / total) * 100) : -1
      if (pct >= lastPct + 10) {
        lastPct = pct - (pct % 10)
        onLog?.(`Modell-Download: ${pct}% (${Math.round(done / 1e6)} / ${Math.round(total / 1e6)} MB)`)
      }
    }
    await out.close()
    if (total && done !== total) throw new Error('Modell-Download unvollständig')
    await rename(part, target)
  } catch (e) {
    await out.close().catch(() => {})
    await rm(part, { force: true })
    throw e
  }
  onLog?.(`Modell "${model}" gespeichert in ${dir}`)
  return target
}

// run whisper-cli, resolve with its stderr tail on success
function runWhisper(args, onLog) {
  return new Promise((resolve, reject) => {
    let bin
    try {
      bin = whisperBinary()
    } catch (e) {
      return reject(e)
    }
    const proc = spawn(bin, args, { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (d) => { tail = (tail + d.toString()).slice(-4000) }
    proc.stdout.on('data', keep)
    proc.stderr.on('data', keep)
    proc.on('error', (e) => reject(new Error(`whisper-cli konnte nicht gestartet werden: ${e.message}`)))
    proc.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`whisper-cli beendet mit ${signal || `Code ${code}`}: ${tail.trim().split('\n').slice(-5).join(' | ')}`))
    })
  })
}

// run whisper.cpp on a 16kHz wav and return the plain transcript text
export async function transcribe(wavFile, { language = 'auto', model = MODEL_NAME, onLog } = {}) {
  const modelPath = await ensureModel(model, onLog)
  onLog?.(`Transkribiere mit Modell "${model}" …`)

  // whisper.cpp scales poorly beyond ~8 threads
  const threads = Math.max(1, Math.min(8, cpus().length))
  const outBase = wavFile.replace(/\.wav$/i, '')
  try {
    await runWhisper(
      ['-m', modelPath, '-f', wavFile, '-l', language || 'auto', '-t', String(threads), '-nt', '-otxt', '-of', outBase],
      onLog
    )
  } catch (e) {
    // a broken download would otherwise fail forever; drop it so the next run re-fetches
    if (/failed to load model/.test(e.message) && modelPath.startsWith(modelsDir())) {
      await rm(modelPath, { force: true })
      throw new Error(`${e.message} – Modelldatei war beschädigt und wurde gelöscht, bitte erneut versuchen.`)
    }
    throw e
  }

  const txtPath = `${outBase}.txt`
  let text = ''
  try {
    text = await readFile(txtPath, 'utf8')
  } catch {
    // leave empty, caller handles it
  }
  await rm(txtPath, { force: true })

  // strip whisper.cpp timestamp markers if any slipped through
  return text
    .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '')
    .trim()
}
