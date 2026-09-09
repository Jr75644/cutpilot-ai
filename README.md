# CutPilot AI v0.2

CutPilot is an AI-native video editor starter: import a source clip, describe the finished edit in plain English, let the system analyze scenes/speech/frames, review the AI-built multi-track timeline, revise it conversationally, then render an MP4.

The important design decision in v0.2 is that **AI planning and rendering are separate**. The model edits structured timeline data first. FFmpeg only renders after the timeline is reviewed/approved.

## What changed from v0.1

The original starter proved the pipeline, but it was basically a form plus one long processing job. v0.2 restructures it into a real editor foundation:

- React + TypeScript editor workspace instead of one static form.
- Media/project panel, AI assistant, preview stage, inspector, recent jobs, and multi-track timeline.
- `upload -> analyze -> plan -> review/revise -> render` workflow.
- Iterative AI re-planning without re-uploading the source video.
- Timeline plan can be patched before render.
- Video, text, voiceover, and SFX tracks are represented separately in the UI.
- 9:16, 16:9, 1:1, 4:5, and original export formats.
- Three caption style presets.
- Narration voice generation + automatic original-audio ducking.
- Safer upload limits and job-id/path validation.
- Multi-stage Docker build compiles the React frontend and serves it from FastAPI.

## Current workflow

1. Import a video.
2. Enter an edit prompt, for example:

   > Start in the living room. Cut to the hallway and hold on the door at the end for suspense. Remove dead space. No music. Keep the Ring-style alert I upload and put it where the notification occurs. Add my narration over the clip.

3. CutPilot detects scenes with PySceneDetect, extracts representative frames with FFmpeg, and transcribes speech.
4. The AI receives real scene boundaries, transcript context, frames, and your instruction.
5. A typed edit plan is created and exposed as a multi-track timeline.
6. Review source in/out points in the Inspector or ask the AI to revise the timeline.
7. Choose export format/captions and click **Render video**.
8. FFmpeg cuts, reframes, captions, mixes narration/SFX, and exports the final MP4.

## Architecture

```text
React / TypeScript editor
        |
        v
FastAPI project + job API
        |
        +--> PySceneDetect scene analysis
        +--> FFmpeg frames/audio
        +--> Whisper / faster-whisper transcription
        +--> multimodal AI timeline planner
        |
        v
Validated timeline JSON
        |
        v
FFmpeg renderer + TTS + audio mix
        |
        v
MP4 export
```

See `ARCHITECTURE.md` for the detailed design and `ROADMAP.md` for the build sequence.

## Repository layout

```text
app/
  main.py                 FastAPI routes + job lifecycle
  models.py               typed planner/request models
  processor.py            analysis, AI planning, validation, rendering
  storage.py              local job storage helpers
  static/ + templates/    legacy v0.1 fallback UI

frontend/
  src/App.tsx             complete editor workspace
  src/components/
    PreviewStage.tsx
    Inspector.tsx
    Timeline.tsx
  src/api.ts              frontend API client
  src/types.ts            timeline/job types
  src/styles.css          full editor styling

Dockerfile                multi-stage React + Python build
render.yaml               Render deployment blueprint
```

## Run with Docker (recommended)

1. Copy the environment file:

```bash
cp .env.example .env
```

2. Add your API key to `.env`.

3. Build:

```bash
docker build -t cutpilot-ai .
```

4. Run:

```bash
docker run --rm -p 8000:8000 --env-file .env -v cutpilot-data:/app/data cutpilot-ai
```

5. Open `http://localhost:8000`.

The Docker build installs/builds the React frontend first, then copies `frontend/dist` into the FastAPI image.

## Local developer mode

### Backend

Python 3.11+ and FFmpeg are required.

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

Node 22+ is recommended.

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the FastAPI server on port 8000.

## Local/offline transcription

```bash
pip install -r requirements-local.txt
```

Then:

```env
TRANSCRIBE_PROVIDER=local
WHISPER_MODEL=small
```

The model downloads on first use.

## Main API routes

- `POST /api/jobs` — upload source + create initial AI analysis job.
- `GET /api/jobs` — recent jobs.
- `GET /api/jobs/{id}` — status/progress.
- `GET /api/jobs/{id}/manifest` — scenes, transcript, frames, config, plan.
- `GET /api/jobs/{id}/plan` — current timeline plan.
- `PATCH /api/jobs/{id}/plan` — save manual timeline edits.
- `POST /api/jobs/{id}/replan` — ask AI to revise the existing analysis/timeline.
- `POST /api/jobs/{id}/render` — render the approved plan.
- `GET /api/jobs/{id}/source` — source preview.
- `GET /api/jobs/{id}/download` — finished MP4.

## Open-source building blocks

- **PySceneDetect** — visual cut/transition detection.
- **FFmpeg** — media probing, frame/audio extraction, cut/re-encode, captions, mixing, export.
- **faster-whisper** — optional local transcription.
- **React + Vite** — editor workspace.

The UI/timeline glue code in this starter is original. A later phase can add Remotion for richer motion graphics or adopt ideas/components from open-source NLE projects, but the core timeline should stay provider-independent.

## Important current limitations

v0.2 is a strong product foundation, not yet Premiere/CapCut-level editing:

- Timeline clips are selectable and source ranges can be edited numerically; true drag/trim handles are Phase 2.
- Vertical reframing is currently a center crop, not face/subject tracking yet.
- One uploaded SFX layer is supported.
- Jobs still run in FastAPI background tasks and local storage. Production needs a queue + object storage.
- Preview is source/final video playback, not yet a frame-perfect live composition preview of every unrendered timeline change.
- Caption rendering is subtitle-based; word-by-word animated social captions are planned.

Those limitations are intentional boundaries so the architecture stays clean while the editor grows.
