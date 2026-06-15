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

import { readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// nodejs-whisper is CJS, load it via require interop
const require = createRequire(import.meta.url)

// whisper models supported by nodejs-whisper (see its constants MODELS_LIST)
export const MODELS = [
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v1',
  'large',
  'large-v3-turbo'
]

// whisper model can be overridden, defaults to a balanced offline model
export const MODEL_NAME = process.env.CLAUDITOR_MODEL || 'small'

// the prebuilt whisper-cli bakes an absolute RUNPATH to its shared libs, which
// breaks when the project folder is moved/renamed; point the loader at the libs
// at their actual location instead so it works regardless of the folder path
function ensureWhisperLibPath() {
  const pkgRoot = dirname(require.resolve('nodejs-whisper/package.json'))
  const buildBase = join(pkgRoot, 'cpp/whisper.cpp/build')
  const libDirs = [join(buildBase, 'src'), join(buildBase, 'ggml/src')]
  const existing = process.env.LD_LIBRARY_PATH?.split(':').filter(Boolean) ?? []
  process.env.LD_LIBRARY_PATH = [...libDirs, ...existing.filter((p) => !libDirs.includes(p))].join(':')
}

// run whisper.cpp on a 16kHz wav and return the plain transcript text
export async function transcribe(wavFile, { language = 'auto', model = MODEL_NAME, onLog } = {}) {
  const { nodewhisper } = require('nodejs-whisper')

  ensureWhisperLibPath()
  onLog?.(`Transkribiere mit Modell "${model}" …`)
  // nodejs-whisper does shelljs.cd into its cpp dir and never restores it; guard our cwd
  const cwd0 = process.cwd()
  let result
  try {
    result = await nodewhisper(wavFile, {
      modelName: model,
      autoDownloadModelName: model,
      removeWavFileAfterTranscription: false,
      withCuda: false,
      whisperOptions: {
        outputInText: true,
        outputInSrt: false,
        outputInVtt: false,
        outputInCsv: false,
        translateToEnglish: false,
        wordTimestamps: false,
        language
      }
    })
  } finally {
    try { process.chdir(cwd0) } catch {}
  }

  // newer versions return the transcript directly
  let text = typeof result === 'string' ? result : ''

  // fallback: whisper.cpp writes a sibling .txt file
  if (!text.trim()) {
    const txtPath = `${wavFile}.txt`
    try {
      await access(txtPath)
      text = await readFile(txtPath, 'utf8')
    } catch {
      // leave empty, caller handles it
    }
  }

  // strip whisper.cpp timestamp markers if any slipped through
  return text
    .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '')
    .trim()
}
