from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .models import RenderRequest, ReplanRequest, TimelinePatch
from .processor import analyze_and_plan_job, render_existing_job, replan_existing_job, sanitize_saved_plan
from .storage import JOBS_DIR, config_path, job_dir, plan_path, read_json, status_path, validate_job_id, write_json

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
LEGACY_STATIC = BASE_DIR / "static"
LEGACY_TEMPLATE = BASE_DIR / "templates" / "index.html"

app = FastAPI(title="CutPilot AI", version="0.3.0")
_cors_origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "*").split(",") if x.strip()]
_allow_all_origins = "*" in _cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _allow_all_origins else _cors_origins,
    allow_credentials=not _allow_all_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")
elif LEGACY_STATIC.exists():
    app.mount("/static", StaticFiles(directory=LEGACY_STATIC), name="static")

_lock = threading.Lock()


def write_status(job_id: str, payload: dict[str, Any]) -> None:
    with _lock:
        path = status_path(job_id)
        current = read_json(path, {}) or {}
        current.update(payload)
        write_json(path, current)


def _find_source(folder: Path) -> Path | None:
    for p in folder.glob("input.*"):
        if p.is_file():
            return p
    return None


def _safe_download_name(name: str) -> str:
    return "".join(c for c in name if c.isalnum() or c in {"-", "_", "."})[:120] or "file"


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": "0.3.0",
        "ai_configured": bool(os.getenv("OPENAI_API_KEY")),
        "editor_model": os.getenv("OPENAI_EDITOR_MODEL", "gpt-5.6-luna"),
        "transcribe_provider": os.getenv("TRANSCRIBE_PROVIDER", "openai"),
        "workflow": "analyze-plan-review-render",
    }


@app.get("/api/jobs")
def list_jobs(limit: int = 12) -> dict[str, Any]:
    limit = max(1, min(limit, 50))
    rows = []
    for folder in sorted(JOBS_DIR.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
        if not folder.is_dir():
            continue
        status = read_json(folder / "status.json", {}) or {}
        config = read_json(folder / "config.json", {}) or {}
        if not status:
            continue
        rows.append({
            **status,
            "created_at": folder.stat().st_ctime,
            "prompt": config.get("edit_prompt", ""),
            "aspect_ratio": config.get("aspect_ratio", "original"),
        })
        if len(rows) >= limit:
            break
    return {"jobs": rows}


@app.post("/api/jobs")
async def create_job(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    edit_prompt: str = Form(...),
    narration_text: str = Form(""),
    voice: str = Form("alloy"),
    burn_captions: bool = Form(True),
    keep_original_audio: bool = Form(True),
    overlay_audio_at: float | None = Form(None),
    overlay_audio: UploadFile | None = File(None),
    aspect_ratio: str = Form("original"),
    caption_style: str = Form("social"),
) -> dict[str, Any]:
    if not video.filename:
        raise HTTPException(400, "Video file is required")
    if not edit_prompt.strip():
        raise HTTPException(400, "Edit prompt is required")
    if aspect_ratio not in {"original", "9:16", "16:9", "1:1", "4:5"}:
        raise HTTPException(400, "Unsupported aspect ratio")
    if caption_style not in {"clean", "social", "minimal"}:
        raise HTTPException(400, "Unsupported caption style")

    job_id = uuid.uuid4().hex[:12]
    folder = job_dir(job_id)
    folder.mkdir(parents=True, exist_ok=True)

    max_bytes = int(os.getenv("MAX_UPLOAD_MB", "1500")) * 1024 * 1024

    async def save_upload(upload: UploadFile, target: Path) -> int:
        total = 0
        with target.open("wb") as f:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    f.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(413, f"Upload exceeds {os.getenv('MAX_UPLOAD_MB', '1500')} MB limit")
                f.write(chunk)
        return total

    suffix = Path(video.filename).suffix.lower() or ".mp4"
    input_path = folder / f"input{suffix}"
    size = await save_upload(video, input_path)

    overlay_path: Path | None = None
    if overlay_audio and overlay_audio.filename:
        overlay_suffix = Path(overlay_audio.filename).suffix.lower() or ".mp3"
        overlay_path = folder / f"overlay{overlay_suffix}"
        await save_upload(overlay_audio, overlay_path)

    config = {
        "source_name": _safe_download_name(video.filename),
        "source_bytes": size,
        "edit_prompt": edit_prompt.strip(),
        "narration_text": narration_text.strip(),
        "voice": voice,
        "burn_captions": burn_captions,
        "keep_original_audio": keep_original_audio,
        "overlay_audio_at": overlay_audio_at,
        "overlay_audio_path": str(overlay_path) if overlay_path else None,
        "aspect_ratio": aspect_ratio,
        "caption_style": caption_style,
    }
    write_json(config_path(job_id), config)
    write_status(job_id, {
        "job_id": job_id,
        "state": "queued",
        "progress": 3,
        "message": "Upload complete. Starting analysis.",
        "source_url": f"/api/jobs/{job_id}/source",
    })

    background_tasks.add_task(analyze_and_plan_job, job_id, input_path, config, write_status)
    return {"job_id": job_id, "state": "queued"}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    try:
        validate_job_id(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found")
    path = status_path(job_id)
    if not path.exists():
        raise HTTPException(404, "Job not found")
    return read_json(path, {}) or {}


@app.get("/api/jobs/{job_id}/source")
def source_video(job_id: str) -> FileResponse:
    try:
        folder = job_dir(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found")
    source = _find_source(folder)
    if not source:
        raise HTTPException(404, "Source video not found")
    config = read_json(config_path(job_id), {}) or {}
    return FileResponse(source, media_type="video/mp4", filename=config.get("source_name", source.name))


@app.get("/api/jobs/{job_id}/download")
def download_job(job_id: str) -> FileResponse:
    try:
        output = job_dir(job_id) / "output.mp4"
    except ValueError:
        raise HTTPException(404, "Output not found")
    if not output.exists():
        raise HTTPException(404, "Output is not ready")
    return FileResponse(output, media_type="video/mp4", filename=f"cutpilot-{job_id}.mp4")


@app.get("/api/jobs/{job_id}/plan")
def get_plan(job_id: str) -> dict[str, Any]:
    try:
        path = plan_path(job_id)
    except ValueError:
        raise HTTPException(404, "Edit plan not found")
    if not path.exists():
        raise HTTPException(404, "Edit plan is not ready")
    return read_json(path, {}) or {}


@app.patch("/api/jobs/{job_id}/plan")
def update_plan(job_id: str, payload: TimelinePatch) -> dict[str, Any]:
    try:
        folder = job_dir(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found")
    scenes = read_json(folder / "scenes.json", []) or []
    config = read_json(config_path(job_id), {}) or {}
    if not scenes:
        raise HTTPException(409, "Analysis is not ready")
    clean = sanitize_saved_plan(payload.plan, scenes, config)
    write_json(plan_path(job_id), clean)
    write_status(job_id, {"state": "planned", "progress": 100, "message": "Timeline updated"})
    return clean


@app.post("/api/jobs/{job_id}/replan")
def replan(job_id: str, payload: ReplanRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    try:
        folder = job_dir(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found")
    if not (folder / "scenes.json").exists():
        raise HTTPException(409, "Initial analysis is not finished")
    if not payload.edit_prompt.strip():
        raise HTTPException(400, "Edit prompt is required")
    config = read_json(config_path(job_id), {}) or {}
    config["edit_prompt"] = payload.edit_prompt.strip()
    config["narration_text"] = payload.narration_text.strip()
    if payload.voice:
        config["voice"] = payload.voice
    write_json(config_path(job_id), config)
    write_status(job_id, {"state": "planning", "progress": 52, "message": "AI is revising the timeline"})
    background_tasks.add_task(replan_existing_job, job_id, config, write_status)
    return {"job_id": job_id, "state": "planning"}


@app.post("/api/jobs/{job_id}/render")
def render_job(job_id: str, payload: RenderRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    try:
        folder = job_dir(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found")
    if not (folder / "plan.json").exists():
        raise HTTPException(409, "Timeline plan is not ready")
    config = read_json(config_path(job_id), {}) or {}
    if payload.aspect_ratio:
        config["aspect_ratio"] = payload.aspect_ratio
    if payload.caption_style:
        config["caption_style"] = payload.caption_style
    if payload.burn_captions is not None:
        config["burn_captions"] = payload.burn_captions
    if payload.keep_original_audio is not None:
        config["keep_original_audio"] = payload.keep_original_audio
    if payload.voice:
        config["voice"] = payload.voice
    write_json(config_path(job_id), config)
    write_status(job_id, {"state": "rendering", "progress": 68, "message": "Rendering timeline"})
    background_tasks.add_task(render_existing_job, job_id, config, write_status)
    return {"job_id": job_id, "state": "rendering"}


@app.get("/api/jobs/{job_id}/manifest")
def get_manifest(job_id: str) -> dict[str, Any]:
    try:
        folder = job_dir(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found")
    plan = read_json(folder / "plan.json", None)
    scenes = read_json(folder / "scenes.json", []) or []
    transcript = read_json(folder / "transcript.json", []) or []
    frames = []
    frame_dir = folder / "frames"
    if frame_dir.exists():
        frames = [f"/api/jobs/{job_id}/frames/{p.name}" for p in sorted(frame_dir.glob("*.jpg"))]
    return {
        "job_id": job_id,
        "config": read_json(folder / "config.json", {}) or {},
        "status": read_json(folder / "status.json", {}) or {},
        "scenes": scenes,
        "transcript": transcript,
        "frames": frames,
        "plan": plan,
    }


@app.get("/api/jobs/{job_id}/frames/{filename}")
def get_frame(job_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.endswith(".jpg"):
        raise HTTPException(404, "Frame not found")
    try:
        path = job_dir(job_id) / "frames" / filename
    except ValueError:
        raise HTTPException(404, "Frame not found")
    if not path.exists():
        raise HTTPException(404, "Frame not found")
    return FileResponse(path, media_type="image/jpeg")


def _spa_index() -> HTMLResponse:
    if FRONTEND_DIST.exists() and (FRONTEND_DIST / "index.html").exists():
        return HTMLResponse((FRONTEND_DIST / "index.html").read_text(encoding="utf-8"))
    if LEGACY_TEMPLATE.exists():
        return HTMLResponse(LEGACY_TEMPLATE.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>CutPilot AI</h1><p>Frontend has not been built yet.</p>")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return _spa_index()


@app.get("/{path:path}", response_class=HTMLResponse)
def spa_fallback(path: str) -> HTMLResponse:
    if path.startswith("api/") or path.startswith("assets/") or path.startswith("static/"):
        raise HTTPException(404)
    return _spa_index()
