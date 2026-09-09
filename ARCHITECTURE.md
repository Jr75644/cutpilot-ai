# CutPilot AI architecture

## Product principle

The AI should **edit a timeline**, not directly mutate video files. Every AI action becomes structured timeline data that a deterministic renderer can validate, display, revise, and export.

## Current v0.2 flow

1. **Import** — browser uploads source video and optional SFX.
2. **Analyze** — FastAPI worker reads duration, detects visual scenes, extracts representative frames, and transcribes speech.
3. **Plan** — multimodal AI receives the user's edit prompt + scene manifest + transcript context + representative frames and returns a typed edit plan.
4. **Review** — React UI displays the plan as multi-track timeline data. The user can inspect/trim source ranges and ask AI to revise the existing plan without re-uploading.
5. **Render** — FFmpeg executes the approved cuts, aspect-ratio transform, captions, text overlays, TTS narration, audio ducking, and uploaded SFX.
6. **Export** — browser previews/downloads the final MP4.

## Repository layout

```text
app/
  main.py          API routes, job lifecycle, SPA hosting
  models.py        typed AI/timeline request models
  processor.py     analysis, planning, validation, FFmpeg render
  storage.py       local job storage helpers
frontend/
  src/App.tsx      editor workspace + project flow
  src/components/  timeline, inspector, preview
  src/api.ts       typed API wrapper
  src/types.ts     frontend job/timeline types
```

## Why the plan/render split matters

The first prototype did everything in one background task. That is fast to prove but hard to turn into a real editor. v0.2 creates an explicit `planned` state and a separate render command. This makes the following possible without redesigning the backend:

- drag/trim/reorder timeline clips;
- ask the AI to revise an existing timeline;
- switch aspect ratio or caption style before export;
- add more tracks (music, B-roll, overlays, images);
- version and undo edit decisions;
- save projects independently from renders.

## Production boundary

The starter intentionally keeps jobs on local disk and background tasks in the API process. For public production deployment, the next infrastructure split should be:

`Web app -> API -> queue -> GPU/CPU render workers -> object storage -> CDN`

Suggested services:

- Postgres for project/job metadata;
- Redis + Celery/RQ/Arq for analysis/render jobs;
- S3/R2 for source media, frames, narration, and exports;
- signed upload/download URLs for large files;
- WebSocket/SSE progress updates instead of polling.
