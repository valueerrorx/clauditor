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

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// read every existing protocol so Claude can build cross-references
export async function readExistingNotes(dir) {
  await mkdir(dir, { recursive: true })
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  const notes = []
  for (const file of files) {
    const content = await readFile(join(dir, file), 'utf8')
    notes.push({ file, content })
  }
  return notes
}

// build a timestamp based filename like 2026-06-15_14-30.md
export function buildFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const d = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
  const t = `${p(date.getHours())}-${p(date.getMinutes())}`
  return `${d}_${t}.md`
}

// persist the generated protocol and return its absolute path
export async function saveNote(dir, filename, content) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, filename)
  await writeFile(path, content, 'utf8')
  return path
}
