from __future__ import annotations

import base64
import json
import os
import shlex
import subprocess
from pathlib import Path
from typing import Any, Callable

from scenedetect import SceneManager, open_video
from scenedetect.detectors import ContentDetector

from .models import AIEditPlan
from .storage import job_dir, plan_path, read_json, write_json

StatusWriter = Callable[[str, dict[str, Any]], None]


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode:
        pretty = " ".join(shlex.quote(x) for x in cmd)
        raise RuntimeError(f"Command failed: {pretty}\n{proc.stderr[-4000:]}")
    return proc.stdout


def ffprobe_duration(path: Path) -> float:
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ]).strip()
    return max(0.1, float(out))


def has_audio(path: Path) -> bool:
    proc = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path),
    ], capture_output=True, text=True)
    return proc.returncode == 0 and "audio" in proc.stdout


def detect_scenes(path: Path, duration: float) -> list[dict[str, Any]]:
    video = open_video(str(path))
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=float(os.getenv("SCENE_THRESHOLD", "27"))))
    manager.detect_scenes(video)
    result = []
    for i, (start_tc, end_tc) in enumerate(manager.get_scene_list()):
        start = max(0.0, start_tc.get_seconds())
        end = min(duration, end_tc.get_seconds())
        if end - start >= 0.12:
            result.append({
                "id": i,
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
            })
    return result or [{"id": 0, "start": 0.0, "end": duration, "duration": duration}]


def extract_frames(path: Path, scenes: list[dict[str, Any]], folder: Path, max_frames: int = 16) -> list[dict[str, Any]]:
    frame_dir = folder / "frames"
    frame_dir.mkdir(exist_ok=True)
    if len(scenes) > max_frames:
        step = (len(scenes) - 1) / (max_frames - 1)
        selected = [scenes[round(i * step)] for i in range(max_frames)]
    else:
        selected = scenes
    frames = []
    seen = set()
    for scene in selected:
        if scene["id"] in seen:
            continue
        seen.add(scene["id"])
        at = scene["start"] + scene["duration"] / 2
        out = frame_dir / f"scene-{scene['id']:03d}.jpg"
        run([
            "ffmpeg", "-y", "-ss", f"{at:.3f}", "-i", str(path),
            "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "4", str(out),
        ])
        frames.append({"scene_id": scene["id"], "time": round(at, 3), "path": out})
    return frames


def extract_audio(path: Path, folder: Path) -> Path | None:
    if not has_audio(path):
        return None
    out = folder / "source-audio.mp3"
    run(["ffmpeg", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "96k", str(out)])
    return out


def transcribe(audio: Path | None) -> list[dict[str, Any]]:
    if not audio:
        return []
    if os.getenv("TRANSCRIBE_PROVIDER", "openai").lower() == "local":
        from faster_whisper import WhisperModel
        model = WhisperModel(
            os.getenv("WHISPER_MODEL", "small"),
            device=os.getenv("WHISPER_DEVICE", "cpu"),
            compute_type=os.getenv("WHISPER_COMPUTE", "int8"),
        )
        segments, _ = model.transcribe(str(audio), vad_filter=True)
        return [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()} for s in segments]

    if not os.getenv("OPENAI_API_KEY"):
        return []

    from openai import OpenAI
    client = OpenAI()
    with audio.open("rb") as f:
        resp = client.audio.transcriptions.create(
            model=os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1"),
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    result = []
    for seg in getattr(resp, "segments", None) or []:
        if isinstance(seg, dict):
            result.append({"start": float(seg.get("start", 0)), "end": float(seg.get("end", 0)), "text": str(seg.get("text", "")).strip()})
        else:
            result.append({"start": float(seg.start), "end": float(seg.end), "text": str(seg.text).strip()})
    return result


def transcript_for_scene(scene: dict[str, Any], transcript: list[dict[str, Any]]) -> str:
    return " ".join(
        s["text"] for s in transcript
        if s["end"] >= scene["start"] and s["start"] <= scene["end"]
    ).strip()


def data_url(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def heuristic_plan(scenes: list[dict[str, Any]], narration: str, sfx_at: float | None) -> dict[str, Any]:
    return sanitize_plan({
        "summary": "AI key is not configured, so all detected scenes were kept.",
        "segments": [{"scene_id": s["id"], "start": s["start"], "end": s["end"], "reason": "Fallback keep"} for s in scenes],
        "headline": "",
        "voiceover": [{"at": 0.2, "text": narration}] if narration else [],
        "text_overlays": [],
        "overlay_audio_at": sfx_at,
    }, scenes, narration, sfx_at)


def ai_plan(
    prompt: str,
    narration: str,
    scenes: list[dict[str, Any]],
    transcript: list[dict[str, Any]],
    frames: list[dict[str, Any]],
    sfx_at: float | None,
) -> dict[str, Any]:
    if not os.getenv("OPENAI_API_KEY"):
        return heuristic_plan(scenes, narration, sfx_at)

    from openai import OpenAI
    client = OpenAI()
    manifest = [{
        "id": s["id"],
        "start": s["start"],
        "end": s["end"],
        "duration": s["duration"],
        "speech": transcript_for_scene(s, transcript)[:900],
    } for s in scenes]

    instructions = f"""You are CutPilot, an AI non-linear video editor.
Create an executable edit decision list from the user's request.

Rules:
- Use only supplied scenes and ORIGINAL source timestamps.
- Every segment must remain inside its scene.
- Keep segments chronological and non-overlapping.
- Prefer natural cuts and useful story context.
- Do not invent visible events.
- voiceover.at and text_overlays.at are FINAL timeline seconds.
- Use supplied narration verbatim unless the user asks for a rewrite.
- If the user says no music, do not recommend or add music.
- overlay_audio_at is FINAL timeline seconds for the uploaded SFX, or null.
- Keep text overlays sparse and short.

USER REQUEST:
{prompt}

NARRATION:
{narration or "(none)"}

REQUESTED SFX TIME:
{sfx_at}

SCENES:
{json.dumps(manifest)}
"""

    content: list[dict[str, Any]] = [{"type": "input_text", "text": instructions}]
    for frame in frames:
        content.append({"type": "input_text", "text": f"Scene {frame['scene_id']} frame at {frame['time']}s"})
        content.append({"type": "input_image", "image_url": data_url(frame["path"])})

    response = client.responses.parse(
        model=os.getenv("OPENAI_EDITOR_MODEL", "gpt-5.6-luna"),
        input=[{"role": "user", "content": content}],
        text_format=AIEditPlan,
    )
    parsed = getattr(response, "output_parsed", None)
    if parsed is None:
        for item in getattr(response, "output", []) or []:
            for part in getattr(item, "content", []) or []:
                parsed = getattr(part, "parsed", None) or parsed
    if parsed is None:
        raise RuntimeError("AI planner did not return structured output")
    raw = parsed.model_dump() if hasattr(parsed, "model_dump") else dict(parsed)
    return sanitize_plan(raw, scenes, narration, sfx_at)


def sanitize_plan(plan: dict[str, Any], scenes: list[dict[str, Any]], narration: str, sfx_at: float | None) -> dict[str, Any]:
    by_id = {int(s["id"]): s for s in scenes}
    clean = []
    for raw in plan.get("segments", []):
        try:
            sid = int(raw["scene_id"])
            scene = by_id[sid]
            start = max(float(scene["start"]), float(raw.get("start", scene["start"])))
            end = min(float(scene["end"]), float(raw.get("end", scene["end"])))
            if end - start < 0.12:
                continue
            clean.append({
                "scene_id": sid,
                "start": round(start, 3),
                "end": round(end, 3),
                "reason": str(raw.get("reason", "AI selected"))[:500],
            })
        except Exception:
            continue
    clean.sort(key=lambda x: (x["start"], x["end"]))
    ordered = []
    last_end = -1.0
    for seg in clean:
        if seg["start"] >= last_end - 1e-6:
            ordered.append(seg)
            last_end = seg["end"]
    if not ordered:
        ordered = [{"scene_id": s["id"], "start": s["start"], "end": s["end"], "reason": "Safety fallback"} for s in scenes]

    voiceover = []
    for item in plan.get("voiceover", []):
        text = str(item.get("text", "")).strip()
        if text:
            voiceover.append({"at": max(0.0, float(item.get("at", 0))), "text": text[:4000]})
    if narration and not voiceover:
        voiceover = [{"at": 0.2, "text": narration}]

    overlays = []
    for item in plan.get("text_overlays", []):
        text = str(item.get("text", "")).strip()
        if text:
            overlays.append({
                "at": max(0.0, float(item.get("at", 0))),
                "duration": max(0.25, float(item.get("duration", 2.5))),
                "text": text[:220],
                "position": item.get("position", "center") if item.get("position") in {"top", "center", "bottom"} else "center",
            })

    result = {
        "version": 2,
        "summary": str(plan.get("summary", "Timeline ready"))[:1200],
        "segments": ordered,
        "headline": str(plan.get("headline", ""))[:140],
        "voiceover": voiceover,
        "text_overlays": overlays,
        "overlay_audio_at": plan.get("overlay_audio_at", sfx_at),
    }
    result["timeline"] = build_timeline(result)
    return result


def sanitize_saved_plan(plan: dict[str, Any], scenes: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    return sanitize_plan(plan, scenes, config.get("narration_text", ""), config.get("overlay_audio_at"))


def build_timeline(plan: dict[str, Any]) -> dict[str, Any]:
    video_clips = []
    cursor = 0.0
    for i, seg in enumerate(plan["segments"]):
        dur = seg["end"] - seg["start"]
        video_clips.append({
            "id": f"video-{i}",
            "kind": "video",
            "scene_id": seg["scene_id"],
            "source_start": seg["start"],
            "source_end": seg["end"],
            "timeline_start": round(cursor, 3),
            "timeline_end": round(cursor + dur, 3),
            "label": f"Scene {seg['scene_id'] + 1}",
            "reason": seg["reason"],
        })
        cursor += dur

    text_clips = [{
        "id": f"text-{i}", "kind": "text", "timeline_start": float(x["at"]),
        "timeline_end": float(x["at"]) + float(x["duration"]), "label": x["text"][:30],
        "text": x["text"], "position": x["position"],
    } for i, x in enumerate(plan.get("text_overlays", []))]

    voice_clips = [{
        "id": f"voice-{i}", "kind": "voiceover", "timeline_start": float(x["at"]),
        "timeline_end": float(x["at"]) + 3.0, "label": "AI Voice", "text": x["text"],
    } for i, x in enumerate(plan.get("voiceover", []))]

    sfx_clips = []
    if plan.get("overlay_audio_at") is not None:
        at = max(0.0, float(plan["overlay_audio_at"]))
        sfx_clips = [{"id": "sfx-0", "kind": "sfx", "timeline_start": at, "timeline_end": at + 1.5, "label": "Uploaded SFX"}]

    duration = max([cursor] + [c["timeline_end"] for c in text_clips + voice_clips + sfx_clips])
    return {
        "duration": round(duration, 3),
        "tracks": [
            {"id": "video", "kind": "video", "label": "Video 1", "clips": video_clips},
            {"id": "text", "kind": "text", "label": "Text", "clips": text_clips},
            {"id": "voice", "kind": "voiceover", "label": "Voiceover", "clips": voice_clips},
            {"id": "sfx", "kind": "sfx", "label": "SFX", "clips": sfx_clips},
        ],
    }


def aspect_filter(aspect: str) -> str | None:
    if aspect == "9:16":
        return "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920"
    if aspect == "16:9":
        return "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=1920:1080"
    if aspect == "1:1":
        return "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080"
    if aspect == "4:5":
        return "crop='min(iw,ih*4/5)':'min(ih,iw*5/4)',scale=1080:1350"
    return None


def render_cuts(source: Path, segments: list[dict[str, Any]], folder: Path, keep_audio: bool, aspect: str) -> Path:
    clip_dir = folder / "render-clips"
    clip_dir.mkdir(exist_ok=True)
    clip_paths = []
    vf = aspect_filter(aspect)
    for i, seg in enumerate(segments):
        out = clip_dir / f"{i:03d}.mp4"
        cmd = [
            "ffmpeg", "-y", "-ss", f"{seg['start']:.3f}", "-to", f"{seg['end']:.3f}",
            "-i", str(source),
        ]
        if vf:
            cmd += ["-vf", vf]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        if keep_audio and has_audio(source):
            cmd += ["-c:a", "aac", "-b:a", "160k"]
        else:
            cmd += ["-an"]
        cmd += ["-movflags", "+faststart", str(out)]
        run(cmd)
        clip_paths.append(out)

    concat = folder / "concat.txt"
    concat.write_text("\n".join(f"file '{p.as_posix()}'" for p in clip_paths), encoding="utf-8")
    out = folder / "cuts.mp4"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(out)])
    return out


def tts(text: str, voice: str, out: Path) -> None:
    if not text.strip() or not os.getenv("OPENAI_API_KEY"):
        return
    from openai import OpenAI
    client = OpenAI()
    response = client.audio.speech.create(
        model=os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
        voice=voice,
        input=text,
    )
    response.stream_to_file(out)


def escape_drawtext(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("%", "\\%")


def finish_render(cuts: Path, output: Path, folder: Path, plan: dict[str, Any], config: dict[str, Any]) -> None:
    cmd = ["ffmpeg", "-y", "-i", str(cuts)]
    voice_inputs = []
    for i, item in enumerate(plan.get("voiceover", [])):
        voice_file = folder / f"voice-{i:02d}.mp3"
        tts(item["text"], str(config.get("voice", "alloy")), voice_file)
        if voice_file.exists():
            voice_inputs.append((voice_file, int(float(item["at"]) * 1000)))
            cmd += ["-i", str(voice_file)]

    overlay = config.get("overlay_audio_path")
    overlay_index = None
    if overlay and Path(overlay).exists() and plan.get("overlay_audio_at") is not None:
        overlay_index = 1 + len(voice_inputs)
        cmd += ["-i", str(overlay)]

    filters = []
    vf = []
    headline = str(plan.get("headline", "")).strip()
    font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if headline:
        vf.append(
            f"drawtext=fontfile='{font}':text='{escape_drawtext(headline)}':"
            "fontcolor=white:fontsize=h/18:borderw=3:bordercolor=black@0.8:"
            "x=(w-text_w)/2:y=h*0.08:enable='between(t,0,3.5)'"
        )
    for item in plan.get("text_overlays", []):
        at = float(item["at"]); end = at + float(item["duration"])
        y = {"top": "h*0.12", "center": "(h-text_h)/2", "bottom": "h*0.78"}.get(item.get("position"), "(h-text_h)/2")
        vf.append(
            f"drawtext=fontfile='{font}':text='{escape_drawtext(item['text'])}':"
            f"fontcolor=white:fontsize=h/16:borderw=3:bordercolor=black@0.8:"
            f"x=(w-text_w)/2:y={y}:enable='between(t,{at:.3f},{end:.3f})'"
        )
    if vf:
        filters.append(f"[0:v]{','.join(vf)}[vout]")

    audio_labels = []
    if bool(config.get("keep_original_audio", True)) and has_audio(cuts):
        filters.append("[0:a]volume=1.0[base]")
        audio_labels.append("[base]")

    for i, (_path, delay) in enumerate(voice_inputs):
        idx = i + 1
        filters.append(f"[{idx}:a]adelay={delay}|{delay},volume=1.0[vo{i}]")
        audio_labels.append(f"[vo{i}]")

    if overlay_index is not None:
        delay = int(float(plan["overlay_audio_at"]) * 1000)
        filters.append(f"[{overlay_index}:a]adelay={delay}|{delay},volume=0.95[sfx]")
        audio_labels.append("[sfx]")

    if len(audio_labels) > 1:
        filters.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest[aout]")
    elif len(audio_labels) == 1:
        filters.append(f"{audio_labels[0]}anull[aout]")

    if filters:
        cmd += ["-filter_complex", ";".join(filters)]
        cmd += ["-map", "[vout]" if vf else "0:v"]
        if audio_labels:
            cmd += ["-map", "[aout]"]
    else:
        cmd += ["-map", "0:v", "-map", "0:a?"]

    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    if audio_labels or has_audio(cuts):
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += ["-movflags", "+faststart", "-t", f"{ffprobe_duration(cuts):.3f}", str(output)]
    run(cmd)


def _load_frames(folder: Path) -> list[dict[str, Any]]:
    scenes = read_json(folder / "scenes.json", []) or []
    by_id = {int(s["id"]): s for s in scenes}
    result = []
    frame_dir = folder / "frames"
    if not frame_dir.exists():
        return result
    for p in sorted(frame_dir.glob("scene-*.jpg")):
        try:
            sid = int(p.stem.split("-")[-1])
            scene = by_id[sid]
            result.append({"scene_id": sid, "time": round(scene["start"] + scene["duration"] / 2, 3), "path": p})
        except Exception:
            pass
    return result


def analyze_and_plan_job(job_id: str, input_path: Path, config: dict[str, Any], write_status: StatusWriter) -> None:
    folder = input_path.parent
    try:
        write_status(job_id, {"state": "analyzing", "progress": 10, "message": "Reading video structure"})
        duration = ffprobe_duration(input_path)
        scenes = detect_scenes(input_path, duration)
        write_json(folder / "scenes.json", scenes)

        write_status(job_id, {"progress": 25, "message": f"Detected {len(scenes)} scene(s)"})
        frames = extract_frames(input_path, scenes, folder)
        audio = extract_audio(input_path, folder)

        write_status(job_id, {"progress": 40, "message": "Transcribing speech"})
        transcript = transcribe(audio)
        write_json(folder / "transcript.json", transcript)

        write_status(job_id, {"state": "planning", "progress": 58, "message": "AI is building the timeline"})
        plan = ai_plan(config["edit_prompt"], config.get("narration_text", ""), scenes, transcript, frames, config.get("overlay_audio_at"))
        write_json(plan_path(job_id), plan)

        write_status(job_id, {
            "state": "planned", "progress": 100, "message": "Timeline ready to review",
            "plan_url": f"/api/jobs/{job_id}/plan",
            "manifest_url": f"/api/jobs/{job_id}/manifest",
            "summary": plan["summary"],
            "timeline_duration": plan["timeline"]["duration"],
        })
    except Exception as exc:
        (folder / "error.txt").write_text(str(exc), encoding="utf-8")
        write_status(job_id, {"state": "error", "progress": 100, "message": str(exc)[-1800:]})


def replan_existing_job(job_id: str, config: dict[str, Any], write_status: StatusWriter) -> None:
    folder = job_dir(job_id)
    try:
        scenes = read_json(folder / "scenes.json", []) or []
        transcript = read_json(folder / "transcript.json", []) or []
        plan = ai_plan(config["edit_prompt"], config.get("narration_text", ""), scenes, transcript, _load_frames(folder), config.get("overlay_audio_at"))
        write_json(plan_path(job_id), plan)
        write_status(job_id, {
            "state": "planned", "progress": 100, "message": "AI revision ready",
            "summary": plan["summary"], "timeline_duration": plan["timeline"]["duration"],
        })
    except Exception as exc:
        write_status(job_id, {"state": "error", "progress": 100, "message": str(exc)[-1800:]})


def render_existing_job(job_id: str, config: dict[str, Any], write_status: StatusWriter) -> None:
    folder = job_dir(job_id)
    source = next((p for p in folder.glob("input.*") if p.is_file()), None)
    if not source:
        write_status(job_id, {"state": "error", "progress": 100, "message": "Source video is missing"})
        return
    try:
        plan = read_json(plan_path(job_id), None)
        if not plan:
            raise RuntimeError("Edit plan is missing")
        write_status(job_id, {"state": "rendering", "progress": 72, "message": "Cutting selected clips"})
        cuts = render_cuts(source, plan["segments"], folder, bool(config.get("keep_original_audio", True)), str(config.get("aspect_ratio", "original")))
        write_status(job_id, {"progress": 88, "message": "Mixing text, voice and sound"})
        output = folder / "output.mp4"
        finish_render(cuts, output, folder, plan, config)
        write_status(job_id, {
            "state": "done", "progress": 100, "message": "Render complete",
            "download_url": f"/api/jobs/{job_id}/download",
            "plan_url": f"/api/jobs/{job_id}/plan", "summary": plan["summary"],
        })
    except Exception as exc:
        (folder / "error.txt").write_text(str(exc), encoding="utf-8")
        write_status(job_id, {"state": "error", "progress": 100, "message": str(exc)[-1800:]})
