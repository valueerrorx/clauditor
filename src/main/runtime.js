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

// Runtime environment helpers that make the app behave the same whether it is
// started via `npm run dev` from a terminal or as an AppImage from the desktop
// menu (minimal PATH, read-only mount, no build tools).

import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// AppImage runtime vars that must not leak into spawned host programs
const APPIMAGE_VARS = [
  'APPIMAGE', 'APPDIR', 'ARGV0', 'APPRUN', 'OWD',
  'TARGET_APPIMAGE', 'REDIRECT_APPIMAGE', 'DESKTOPINTEGRATION',
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'PERLLIB',
  'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH'
]

// env for spawning host programs (ffmpeg, claude, uv, obsidian …) without AppImage residue
export function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of APPIMAGE_VARS) delete env[key]
  for (const key of ['PATH', 'XDG_DATA_DIRS']) {
    if (!env[key]) continue
    env[key] = env[key].split(':').filter((p) => !p.includes('/.mount_')).join(':')
  }
  return { ...env, ...extra }
}

// Apps launched from a desktop menu get a minimal PATH that usually lacks
// ~/.local/bin (claude, uv), nvm/npm-global dirs etc. Merge in the PATH of the
// user's login shell plus well-known install locations, once at startup.
export function fixPath() {
  const home = homedir()
  // the app itself needs none of the AppImage vars after startup; dropping them
  // here keeps every spawned child (ffmpeg, pactl, claude, uv …) clean
  const cleaned = cleanEnv()
  for (const key of APPIMAGE_VARS) delete process.env[key]
  if (cleaned.XDG_DATA_DIRS !== undefined) process.env.XDG_DATA_DIRS = cleaned.XDG_DATA_DIRS
  const parts = (process.env.PATH || '').split(delimiter).filter(Boolean)

  const shell = process.env.SHELL || '/bin/bash'
  try {
    // login shell picks up ~/.profile-style PATH additions; markers guard
    // against noisy rc files printing extra output
    const out = execFileSync(shell, ['-lc', 'echo "__CLAUDITOR_PATH__${PATH}__CLAUDITOR_PATH__"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanEnv()
    })
    const m = out.match(/__CLAUDITOR_PATH__(.*)__CLAUDITOR_PATH__/)
    if (m) parts.push(...m[1].split(delimiter).filter(Boolean))
  } catch {
    // shell not usable, rely on the fallbacks below
  }

  parts.push(
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    join(home, '.npm-global/bin'),
    join(home, '.cargo/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  )
  // nvm keeps node (and npm-installed claude) in per-version bin dirs
  try {
    const nvm = join(home, '.nvm/versions/node')
    for (const v of readdirSync(nvm).sort().reverse()) parts.push(join(nvm, v, 'bin'))
  } catch {}
  process.env.PATH = [...new Set(parts)].filter((p) => !p.includes('/.mount_')).join(delimiter)
}

// find an executable on PATH, returns its full path or null
export function which(cmd) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, cmd)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {}
  }
  return null
}

// pick the fastest whisper-cli build the CPU supports
function cpuVariant() {
  if (process.arch !== 'x64') return 'generic'
  try {
    const flags = readFileSync('/proc/cpuinfo', 'utf8').match(/^flags\s*:(.*)$/m)?.[1].split(/\s+/) ?? []
    const need = ['avx', 'avx2', 'fma', 'f16c', 'bmi2']
    return need.every((f) => flags.includes(f)) ? 'avx2' : 'generic'
  } catch {
    return 'generic'
  }
}

// location of the bundled whisper-cli (extraResources in the package, vendor/ in dev)
export function whisperBinary() {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'vendor', 'whisper')
  for (const variant of [cpuVariant(), 'generic']) {
    const p = join(base, variant, 'whisper-cli')
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {}
  }
  throw new Error(
    app.isPackaged
      ? `whisper-cli fehlt im Paket (${base}).`
      : 'whisper-cli nicht gebaut – bitte "npm run whisper" ausführen.'
  )
}

// writable folder for downloaded whisper models (~/.config/clauditor/models)
export function modelsDir() {
  return join(app.getPath('userData'), 'models')
}

// check external programs the app relies on, for a hint in the UI
export function checkDependencies() {
  const deps = [
    { name: 'ffmpeg', hint: 'für Aufnahme und Import (Paket "ffmpeg")', required: true },
    { name: 'pactl', hint: 'zum Auflisten der Audioquellen (Paket "pulseaudio-utils" bzw. "libpulse")', required: true },
    { name: 'claude', hint: 'Claude Code CLI, installiert und eingeloggt (https://claude.com/claude-code)', required: true },
    { name: 'uv', hint: 'nur für die Sprechererkennung (https://docs.astral.sh/uv/)', required: false }
  ]
  return deps.map((d) => ({ ...d, found: Boolean(which(d.name)) }))
}
