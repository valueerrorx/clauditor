import { readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'

// nodejs-whisper is CJS, load it via require interop
const require = createRequire(import.meta.url)

// whisper model can be overridden, defaults to a balanced offline model
export const MODEL_NAME = process.env.CLAUDITOR_MODEL || 'small'

// run whisper.cpp on a 16kHz wav and return the plain transcript text
export async function transcribe(wavFile, { language = 'auto', onLog } = {}) {
  const { nodewhisper } = require('nodejs-whisper')

  onLog?.(`Transkribiere mit Modell "${MODEL_NAME}" …`)
  // nodejs-whisper does shelljs.cd into its cpp dir and never restores it; guard our cwd
  const cwd0 = process.cwd()
  let result
  try {
    result = await nodewhisper(wavFile, {
      modelName: MODEL_NAME,
      autoDownloadModelName: MODEL_NAME,
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
