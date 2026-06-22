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
import { tmpdir } from 'node:os'

// keep the prompt bounded so large archives stay within context limits
const MAX_NOTE_CHARS = 4000
const MAX_NOTES = 40

function buildContext(notes) {
  if (!notes.length) return 'Es existieren noch keine früheren Protokolle.'
  return notes
    .slice(-MAX_NOTES)
    .map(({ file, content }) => {
      const body = content.length > MAX_NOTE_CHARS
        ? `${content.slice(0, MAX_NOTE_CHARS)}\n…(gekürzt)`
        : content
      return `### Datei: ${file}\n${body}`
    })
    .join('\n\n---\n\n')
}

function speakerRules(diarized) {
  if (diarized) {
    return `- Das Transkript ist nach Sprechern getrennt; jede Zeile beginnt mit einem Label wie "SPEAKER_00:", "SPEAKER_01:".
- Wenn sich eine Person im Verlauf mit Namen vorstellt (z. B. "Ich bin Anna", "hier ist Markus"), ordne das jeweilige Label diesem echten Namen zu und verwende danach den echten Namen.
- Weise Sprecher NUR dort zu, wo es inhaltlich nötig ist (z. B. Verantwortliche für Aufgaben, wichtige Aussagen/Entscheidungen). Markiere NICHT jeden Punkt mit einem Sprecher.
- Lässt sich ein Label keinem Namen zuordnen, benenne es neutral (z. B. "eine Teilnehmerin") oder lasse die Zuordnung weg.`
  }
  return `- Das Transkript stammt aus einer gemischten Aufnahme (Mikrofon + Systemton), Sprecher sind nicht eindeutig getrennt. Leite Inhalte sinnvoll ab, erfinde aber keine Sprecherzuordnungen.`
}

function buildPrompt({ transcript, notes, filename, diarized }) {
  const context = buildContext(notes)
  return `Du bist ein präziser Protokollant. Du erstellst aus einem Roh-Transkript einer Besprechung ein strukturiertes Meeting-Protokoll in deutschem Markdown.

WICHTIGE REGELN:
- Antworte AUSSCHLIESSLICH mit dem fertigen Markdown-Protokoll, ohne einleitende oder abschließende Kommentare.
- Erfinde keine Fakten.
${speakerRules(diarized)}
- Nutze die früheren Protokolle als Kontext. Wenn es thematische Zusammenhänge gibt, erwähne sie und setze Querverweise im Format [[dateiname.md]] auf die jeweils relevante Datei.

DATENSCHUTZ & RELEVANZ (ZWINGEND, hat Vorrang vor Vollständigkeit):
- Nimm ausschließlich fachliche, für das Meeting relevante Inhalte auf.
- Niemals Privates/Persönliches, das nichts mit dem Meeting-Thema zu tun hat (z. B. Gesundheit, Familie, private Pläne) – ersatzlos weglassen.
- Keinerlei Diffamierung, Beleidigungen, Hate Speech oder abfällige Bemerkungen bzw. Witze über Personen – weglassen; falls ein sachlicher Kern existiert, nur diesen neutral formulieren.
- Im Zweifel weglassen.

STRUKTUR DES PROTOKOLLS (das Datum ist IMMER die Hauptüberschrift, alles andere liegt darunter):
# <Datum im Format YYYY-MM-DD, aus dem Dateinamen "${filename}" ableiten>

## <kurzer, prägnanter Meeting-Titel>

### Anwesende
<ungeordnete Liste (- ) ALLER im Meeting erkannten Sprecher; bei bekanntem Namen den Namen verwenden, sonst das Label (z. B. SPEAKER_00) oder eine neutrale Bezeichnung. "Keine eindeutig erkannt", falls sich niemand zuordnen lässt.>

### Zusammenfassung
<3-6 Sätze>

### Besprochene Themen
<gegliederte Punkte>

### Entscheidungen
<falls vorhanden>

### Aufgaben / To-dos
<- [ ] Aufgabe – Verantwortlich (falls erkennbar)>

### Zusammenhänge mit früheren Protokollen
<Querverweise [[datei.md]] und kurze Erklärung des Zusammenhangs; "Keine" wenn nichts passt>

=== FRÜHERE PROTOKOLLE (KONTEXT) ===
${context}

=== ROH-TRANSKRIPT DER AKTUELLEN AUFNAHME ===
${transcript}
`
}

// invoke the locally registered Claude Code CLI in headless print mode
export function summarize({ transcript, notes, filename, diarized = false, onLog }) {
  const prompt = buildPrompt({ transcript, notes, filename, diarized })

  return new Promise((resolve, reject) => {
    onLog?.('Analysiere mit Claude …')
    // run from a neutral cwd so Claude does not scan a project folder for context
    const proc = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpdir() })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      // claude prints errors (e.g. 401 auth) to stdout, so include both streams
      else {
        const detail = (stderr.trim() || stdout.trim()) || 'keine Ausgabe'
        reject(new Error(`Claude beendet mit Code ${code}: ${detail}`))
      }
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}
