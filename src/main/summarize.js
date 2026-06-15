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

function buildPrompt({ transcript, notes, filename }) {
  const context = buildContext(notes)
  return `Du bist ein präziser Protokollant. Du erstellst aus einem Roh-Transkript einer Besprechung ein strukturiertes Meeting-Protokoll in deutschem Markdown.

WICHTIGE REGELN:
- Antworte AUSSCHLIESSLICH mit dem fertigen Markdown-Protokoll, ohne einleitende oder abschließende Kommentare.
- Das Transkript stammt aus einer gemischten Aufnahme (Mikrofon + Systemton), Sprecher sind nicht eindeutig getrennt. Leite Inhalte sinnvoll ab, erfinde aber keine Fakten.
- Nutze die früheren Protokolle als Kontext. Wenn es thematische Zusammenhänge gibt, erwähne sie und setze Querverweise im Format [[dateiname.md]] auf die jeweils relevante Datei.

STRUKTUR DES PROTOKOLLS:
# Meeting-Protokoll – <kurzer Titel>
**Datei:** ${filename}
**Datum:** <aus dem Dateinamen ableiten>

## Zusammenfassung
<3-6 Sätze>

## Besprochene Themen
<gegliederte Punkte>

## Entscheidungen
<falls vorhanden>

## Aufgaben / To-dos
<- [ ] Aufgabe – Verantwortlich (falls erkennbar)>

## Zusammenhänge mit früheren Protokollen
<Querverweise [[datei.md]] und kurze Erklärung des Zusammenhangs; "Keine" wenn nichts passt>

=== FRÜHERE PROTOKOLLE (KONTEXT) ===
${context}

=== ROH-TRANSKRIPT DER AKTUELLEN AUFNAHME ===
${transcript}
`
}

// invoke the locally registered Claude Code CLI in headless print mode
export function summarize({ transcript, notes, filename, onLog }) {
  const prompt = buildPrompt({ transcript, notes, filename })

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
      else reject(new Error(`Claude beendet mit Code ${code}: ${stderr || 'keine Ausgabe'}`))
    })

    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}
