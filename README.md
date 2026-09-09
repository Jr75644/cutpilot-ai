# CutPilot AI v0.3

CutPilot is an AI-native, non-destructive video editor. Import a source video, describe the finished edit in plain English, let the system analyze scenes/speech/frames, then review and manually refine the same multi-track timeline the AI created before rendering an MP4.

## v0.3 editor pass

v0.3 turns the v0.2 timeline visualization into an actual editing surface:

- drag video clips horizontally to reorder the cut;
- drag text, voiceover, and SFX clips to retime them;
- trim video clips with edge handles while respecting detected scene boundaries;
- trim text-overlay duration with edge handles;
- split video at the playhead;
- delete clips (with protection against deleting the final video clip);
- undo/redo history (50 checkpoints);
- timeline zoom;
- ruler scrubbing and a real moving playhead;
- pre-render timeline playback that jumps through the source according to the edited cut;
- keyboard shortcuts: Space play/pause, S split, Delete remove, Cmd/Ctrl+Z undo, Cmd/Ctrl+S save;
- 900 ms debounced autosave plus explicit Save;
- stale renders automatically return to `planned` after timeline changes;
- stable clip IDs survive backend validation/saves;
- backend now treats the saved timeline order as the render order, including split clips and reordered scenes;
- render-time settings (captions, source audio, voice, format) are saved immediately before export;
- CI smoke test verifies a reordered + split timeline round-trips into the correct render decision list.

## Core workflow

1. **Import** a source video and optional sound effect.
2. **Prompt** CutPilot in natural language.
3. **Analyze** with PySceneDetect + FFmpeg + timestamped transcription.
4. **Plan** with a multimodal AI model using real scene boundaries, transcript context, and representative frames.
5. **Edit** the generated Video / Text / Voiceover / SFX timeline manually or ask AI to revise it.
6. **Autosave** the canonical timeline JSON.
7. **Render** the exact saved timeline with FFmpeg, captions, narration, audio ducking, reframing, and SFX.
8. **Preview/download** the MP4.

Example prompt:

> Start in the living room. Cut to the hallway sooner and hold on the door for suspense. Remove dead space. No music. Put my Ring alert where the notification happens and add my narration over it.

## Architecture

```text
React / TypeScript NLE
        |
        |  timeline JSON (canonical edit state)
        v
FastAPI project API
        |
        +--> PySceneDetect scene analysis
        +--> FFmpeg frames/audio/probing
        +--> Whisper/faster-whisper transcription
        +--> multimodal AI timeline planner
        |
        v
Validated non-destructive timeline
        |
        v
FFmpeg renderer + captions + TTS + audio mix
        |
        v
MP4 export
```

The critical design rule is: **AI edits timeline data; FFmpeg renders timeline data.** AI never directly destroys the uploaded source.

## Repository layout

```text
app/
  main.py                 FastAPI routes + job lifecycle
  models.py               typed API/planner models
  processor.py            analysis, AI planning, validation, rendering
  storage.py              local project/job storage

frontend/
  src/App.tsx             editor state, autosave, undo/redo, shortcuts
  src/editor.ts            shared non-destructive timeline operations
  src/components/
    PreviewStage.tsx       cut-aware source preview + transport
    Inspector.tsx          selected-clip/project editing
    Timeline.tsx           drag, trim, split controls, zoom, scrub
  src/api.ts               typed API client
  src/types.ts             timeline/job types
  src/styles.css           editor UI styling

scripts/smoke_timeline.py  timeline/render-order smoke test
Dockerfile                 multi-stage frontend + API build
render.yaml                Render deployment blueprint
.github/workflows/ci.yml   backend + frontend CI
```

## Run with Docker

```bash
cp .env.example .env
# put OPENAI_API_KEY in .env
docker build -t cutpilot-ai .
docker run --rm -p 8000:8000 --env-file .env -v cutpilot-data:/app/data cutpilot-ai
```

Open `http://localhost:8000`.

## Local developer mode

Backend (Python 3.11+ and FFmpeg):

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend (Node 22+):

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`; Vite proxies `/api` to port 8000.

## Local transcription

```bash
pip install -r requirements-local.txt
```

```env
TRANSCRIBE_PROVIDER=local
WHISPER_MODEL=small
```

## Main API routes

- `POST /api/jobs` — upload source + begin analysis.
- `GET /api/jobs` — recent jobs.
- `GET /api/jobs/{id}` — status/progress.
- `GET /api/jobs/{id}/manifest` — scenes, transcript, frames, config, plan.
- `GET /api/jobs/{id}/plan` — canonical edit plan.
- `PATCH /api/jobs/{id}/plan` — validate/autosave manual timeline edits.
- `POST /api/jobs/{id}/replan` — ask AI to revise analysis/timeline.
- `POST /api/jobs/{id}/render` — render approved timeline + current export settings.
- `GET /api/jobs/{id}/source` — source preview.
- `GET /api/jobs/{id}/download` — final MP4.

## Current limitations

v0.3 is a serious editor foundation, not yet CapCut/Premiere parity:

- Video-track movement is ripple/reorder editing rather than free gaps/overlaps.
- One uploaded SFX asset is supported per project.
- Voiceover clip width is an estimate until TTS audio is generated.
- Preview is cut-aware for source video but does not yet live-compose text/captions/voice/SFX before render.
- Vertical reframing is center crop, not subject/face tracking yet.
- Caption rendering is subtitle-based, not word-by-word animated social captions yet.
- Jobs use FastAPI background tasks + local disk; production still needs queue workers and object storage.

See `ROADMAP.md` for the next build sequence.
