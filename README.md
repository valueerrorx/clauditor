# clauditor

**clauditor** (von **Claude** + **audit**) ist ein Electron/Vue-Tool, das **Mikrofon + System-Ton** gleichzeitig aufnimmt, **offline mit whisper.cpp** transkribiert und anschließend mit der lokal registrierten **Claude Code CLI** zu einem strukturierten Meeting-Protokoll zusammenfasst. Die Protokolle landen als `datum-uhrzeit.md` in einem Ordner; vorhandene Protokolle werden als Kontext mitgegeben, sodass Claude **Querverweise** (`[[datei.md]]`) und Zusammenhänge erzeugt.

## Funktionsweise

1. **Aufnahme**: `ffmpeg` liest zwei PulseAudio/PipeWire-Quellen gleichzeitig – dein Mikrofon und den `.monitor` deines Ausgabegeräts – und mischt sie live (`amix`) zu einer 16-kHz-Mono-WAV. Kein virtuelles Gerät nötig.
2. **Transkription**: `nodejs-whisper` (whisper.cpp, lokal kompiliert) transkribiert die WAV offline.
3. **Analyse**: Das Transkript geht zusammen mit allen vorhandenen `.md`-Protokollen an `claude -p` (Headless). Claude liefert das fertige Markdown-Protokoll zurück.
4. **Speichern**: Ablage als `YYYY-MM-DD_HH-MM.md` im gewählten Ordner.

## Voraussetzungen

- Linux mit PipeWire/PulseAudio (`pactl`, `parec`)
- `ffmpeg`
- Node.js 20+
- `claude` CLI installiert und eingeloggt
- Build-Tools für whisper.cpp: `cmake`, `make`, `gcc`/`g++`

## Setup

```bash
npm install
# einmalig: Modell laden + whisper.cpp bauen (Standardmodell: small)
node -e "require('nodejs-whisper/dist/autoDownloadModel').default(console,'small',false)"
```

## Starten

```bash
npm run dev
```

Im Fenster: Mikrofon + System-Ton (Monitor) wählen, Protokoll-Ordner setzen, **Aufnahme starten** → reden/Meeting → **Stoppen & Zusammenfassen**.

## Modell wechseln

Über die Umgebungsvariable `CLAUDITOR_MODEL` (z. B. `medium`, `large-v3-turbo`). Neue Modelle werden beim ersten Lauf automatisch geladen und gebaut.

```bash
CLAUDITOR_MODEL=medium npm run dev
```

## Lizenz

Copyright (C) 2026 Thomas Weissel

clauditor ist freie Software unter der **GNU General Public License v3.0 oder später** (GPL-3.0-or-later). Du darfst das Programm weitergeben und/oder verändern – unter den Bedingungen der GPL. Den vollständigen Lizenztext findest du in der Datei [`LICENSE`](./LICENSE) oder unter <https://www.gnu.org/licenses/gpl-3.0.html>.
