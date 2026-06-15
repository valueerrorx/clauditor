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
