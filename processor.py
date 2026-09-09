from __future__ import annotations

import base64
import json
import math
import os
import shlex
import subprocess
import uuid
from pathlib import Path
from typing import Any, Callable

from scenedetect import SceneManager, open_video
from scenedetect.detectors import ContentDetector

from .models import AIEditPlan
from .storage import config_path, job_dir, plan_path, read_json, write_json

StatusWriter = Callable[[str, dict[str, Any]], None]


def run(cmd: list[str], cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(shlex.quote(x) for x in cmd)}\n{proc.stderr[-5000:]}")
    return proc.stdout


def ffprobe_duration(path: Path) -> float:
    out = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ]).strip()
    return max(0.1, float(out))


def has_audio(path: Path) -> bool:
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path),
    ]).strip()
    return "audio" in out


def detect_scenes(path: Path, duration: float) -> list[dict[str, Any]]:
    video = open_video(str(path))
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=float(os.getenv("SCENE_THRESHOLD", "27"))))
    manager.detect_scenes(video)
    scenes = manager.get_scene_list()
    result: list[dict[str, Any]] = []
    for i, (start_tc, end_tc) in enumerate(scenes):
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
    thumbs = folder / "frames"
    thumbs.mkdir(exist_ok=True)
    if len(scenes) <= max_frames:
        picked = scenes
    else:
        step = (len(scenes) - 1) / (max_frames - 1)
        indices = sorted({round(i * step) for i in range(max_frames)})
        picked = [scenes[i] for i in indices]

    frames: list[dict[str, Any]] = []
    for scene in picked:
        mid = scene["start"] + (scene["end"] - scene["start"]) / 2
        outfile = thumbs / f"scene-{scene['id']:03d}.jpg"
        run([
            "ffmpeg", "-y", "-ss", f"{mid:.3f}", "-i", str(path),
            "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "4", str(outfile),
        ])
        frames.append({"scene_id": scene["id"], "time": round(mid, 3), "path": outfile})
    return frames


def extract_audio(path: Path, folder: Path) -> Path | None:
    if not has_audio(path):
        return None
    audio = folder / "source-audio.mp3"
    run(["ffmpeg", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "96k", str(audio)])
    return audio


def transcribe_openai(audio: Path) -> list[dict[str, Any]]:
    from openai import OpenAI

    client = OpenAI()
    model = os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
    with audio.open("rb") as f:
        resp = client.audio.transcriptions.create(
            model=model,
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    raw_segments = getattr(resp, "segments", None) or []
    result = []
    for seg in raw_segments:
        if isinstance(seg, dict):
            start, end, text = seg.get("start", 0), seg.get("end", 0), seg.get("text", "")
        else:
            start, end, text = getattr(seg, "start", 0), getattr(seg, "end", 0), getattr(seg, "text", "")
        result.append({"start": float(start), "end": float(end), "text": str(text).strip()})
    if not result:
        text = getattr(resp, "text", "") or ""
        if text.strip():
            result = [{"start": 0.0, "end": ffprobe_duration(audio), "text": text.strip()}]
    return result


def transcribe_local(audio: Path) -> list[dict[str, Any]]:
    from faster_whisper import WhisperModel

    size = os.getenv("WHISPER_MODEL", "small")
    model = WhisperModel(
        size,
        device=os.getenv("WHISPER_DEVICE", "cpu"),
        compute_type=os.getenv("WHISPER_COMPUTE", "int8"),
    )
    segments, _info = model.transcribe(str(audio), vad_filter=True)
    return [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()} for s in segments]


def transcribe(audio: Path | None) -> list[dict[str, Any]]:
    if audio is None:
        return []
    provider = os.getenv("TRANSCRIBE_PROVIDER", "openai").lower()
    if provider == "local":
        return transcribe_local(audio)
    if not os.getenv("OPENAI_API_KEY"):
        return []
    return transcribe_openai(audio)


def transcript_for_scene(scene: dict[str, Any], transcript: list[dict[str, Any]]) -> str:
    chunks = []
    for seg in transcript:
        if seg["end"] >= scene["start"] and seg["start"] <= scene["end"]:
            chunks.append(seg["text"])
    return " ".join(chunks).strip()


def image_data_url(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def heuristic_plan(scenes: list[dict[str, Any]], narration: str, overlay_audio_at: float | None) -> dict[str, Any]:
    return {
        "version": 2,
        "summary": "Fallback timeline: all detected scenes retained in chronological order.",
        "segments": [
            {"scene_id": s["id"], "start": s["start"], "end": s["end"], "reason": "Fallback keep"}
            for s in scenes
        ],
        "headline": "",
        "voiceover": ([{"at": 0.2, "text": narration}] if narration else []),
        "text_overlays": [],
        "overlay_audio_at": overlay_audio_at,
    }


def _extract_parsed_response(resp: Any) -> Any | None:
    parsed = getattr(resp, "output_parsed", None)
    if parsed is not None:
        return parsed
    for output in getattr(resp, "output", []) or []:
        if getattr(output, "type", "") != "message":
            continue
        for item in getattr(output, "content", []) or []:
            item_parsed = getattr(item, "parsed", None)
            if item_parsed is not None:
                return item_parsed
    return None


def ai_plan(
    prompt: str,
    narration: str,
    scenes: list[dict[str, Any]],
    transcript: list[dict[str, Any]],
    frames: list[dict[str, Any]],
    overlay_audio_at: float | None,
) -> dict[str, Any]:
    if not os.getenv("OPENAI_API_KEY"):
        return heuristic_plan(scenes, narration, overlay_audio_at)

    from openai import OpenAI

    client = OpenAI()
    model = os.getenv("OPENAI_EDITOR_MODEL", "gpt-5.6-luna")

    scene_manifest = [
        {
            "id": s["id"],
            "start": s["start"],
            "end": s["end"],
            "duration": s["duration"],
            "speech": transcript_for_scene(s, transcript)[:900],
        }
        for s in scenes
    ]

    instructions = f"""You are CutPilot, an AI non-linear video editor. Build an executable edit decision list from the user's request.

Important rules:
- Every video segment MUST stay within one supplied scene, using ORIGINAL source time coordinates.
- Segments must be chronological and non-overlapping.
- Do not invent footage or events that are not visible/heard in the supplied material.
- Prefer natural cut points. Avoid clips under 0.35 seconds unless the prompt clearly calls for fast cutting.
- Keep context that is necessary for the requested story to make sense.
- voiceover.at and text_overlays.at are seconds on the FINAL edited timeline.
- If exact narration is provided, use it verbatim unless the user explicitly asks you to rewrite it.
- If the user says no music, do not add or recommend music.
- overlay_audio_at is the final-timeline time for the uploaded extra audio/SFX; use null when it should not be used.
- The headline should be short and empty when a headline would not improve the edit.
- Text overlays are optional and should be sparse, purposeful, and short.

USER EDIT REQUEST:
{prompt}

EXACT/OPTIONAL NARRATION:
{narration or '(none)'}

EXPLICIT SFX TIME (if any):
{overlay_audio_at}

SCENE MANIFEST:
{json.dumps(scene_manifest)}
"""

    content: list[dict[str, Any]] = [{"type": "input_text", "text": instructions}]
    for frame in frames:
        content.append({
            "type": "input_text",
            "text": f"Representative frame: scene {frame['scene_id']} at original time {frame['time']} seconds",
        })
        content.append({"type": "input_image", "image_url": image_data_url(frame["path"])})

    resp = client.responses.parse(
        model=model,
        input=[{"role": "user", "content": content}],
        text_format=AIEditPlan,
    )
    parsed = _extract_parsed_response(resp)
    if parsed is None:
        raise RuntimeError("AI editor did not return a structured edit plan")
    if hasattr(parsed, "model_dump"):
        raw = parsed.model_dump()
    elif isinstance(parsed, dict):
        raw = parsed
    else:
        raw = json.loads(str(parsed))
    return sanitize_plan(raw, scenes, narration, overlay_audio_at)


def _dedupe_and_order_segments(clean: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clean.sort(key=lambda x: (x["start"], x["end"]))
    ordered: list[dict[str, Any]] = []
    last_end = -1.0
    for seg in clean:
        if seg["start"] < last_end - 1e-6:
            continue
        ordered.append(seg)
        last_end = seg["end"]
    return ordered


def sanitize_plan(
    plan: dict[str, Any],
    scenes: list[dict[str, Any]],
    narration: str,
    overlay_audio_at: float | None,
    *,
    preserve_order: bool = False,
) -> dict[str, Any]:
    by_id = {int(s["id"]): s for s in scenes}
    clean: list[dict[str, Any]] = []
    for seg in plan.get("segments", []):
        try:
            sid = int(seg.get("scene_id"))
            scene = by_id[sid]
            start = max(float(scene["start"]), float(seg.get("start", scene["start"])))
            end = min(float(scene["end"]), float(seg.get("end", scene["end"])))
            if end - start < 0.12:
                continue
            clean.append({
                "clip_id": str(seg.get("clip_id") or "")[:120] or None,
                "scene_id": sid,
                "start": round(start, 3),
                "end": round(end, 3),
                "reason": str(seg.get("reason", "AI selected"))[:500],
            })
        except Exception:
            continue
    if not preserve_order:
        clean = _dedupe_and_order_segments(clean)
    if not clean:
        clean = [dict(item) for item in heuristic_plan(scenes, narration, overlay_audio_at)["segments"]]
    edit_duration = max(0.1, sum(float(seg["end"]) - float(seg["start"]) for seg in clean))

    vo = []
    for item in plan.get("voiceover", []):
        try:
            text = str(item.get("text", "")).strip()
            if text:
                vo.append({
                    "id": str(item.get("id") or "")[:120] or None,
                    "at": min(edit_duration, max(0.0, float(item.get("at", 0.0)))),
                    "text": text[:4000],
                })
        except Exception:
            pass
    if narration and not vo:
        vo = [{"id": None, "at": 0.2, "text": narration}]

    overlays = []
    for item in plan.get("text_overlays", []):
        try:
            text = str(item.get("text", "")).strip()
            if not text:
                continue
            position = str(item.get("position", "center"))
            if position not in {"top", "center", "bottom"}:
                position = "center"
            overlays.append({
                "id": str(item.get("id") or "")[:120] or None,
                "at": min(edit_duration, max(0.0, float(item.get("at", 0.0)))),
                "duration": max(0.25, min(edit_duration, 120.0, float(item.get("duration", 2.5)))),
                "text": text[:220],
                "position": position,
            })
        except Exception:
            continue

    oa = plan.get("overlay_audio_at", overlay_audio_at)
    try:
        oa = None if oa is None else min(edit_duration, max(0.0, float(oa)))
    except Exception:
        oa = overlay_audio_at

    normalized = {
        "version": 3,
        "summary": str(plan.get("summary", "AI-generated edit timeline"))[:1200],
        "segments": clean,
        "headline": str(plan.get("headline", ""))[:140],
        "voiceover": vo,
        "text_overlays": overlays,
        "overlay_audio_at": oa,
    }
    normalized["timeline"] = build_timeline(normalized)
    return normalized


def build_timeline(plan: dict[str, Any]) -> dict[str, Any]:
    cursor = 0.0
    video_clips = []
    for i, seg in enumerate(plan.get("segments", [])):
        length = max(0.0, float(seg["end"]) - float(seg["start"]))
        video_clips.append({
            "id": seg.get("clip_id") or f"v-{i + 1:03d}",
            "kind": "video",
            "scene_id": int(seg["scene_id"]),
            "source_start": round(float(seg["start"]), 3),
            "source_end": round(float(seg["end"]), 3),
            "timeline_start": round(cursor, 3),
            "timeline_end": round(cursor + length, 3),
            "label": f"Scene {int(seg['scene_id']) + 1}",
            "reason": seg.get("reason", "AI selected"),
        })
        cursor += length

    voice_clips = [
        {
            "id": v.get("id") or f"vo-{i + 1:02d}",
            "kind": "voiceover",
            "timeline_start": round(float(v.get("at", 0)), 3),
            "timeline_end": round(float(v.get("at", 0)) + 3.0, 3),
            "text": v.get("text", ""),
            "label": "AI Voice",
        }
        for i, v in enumerate(plan.get("voiceover", []))
    ]
    text_clips = [
        {
            "id": v.get("id") or f"tx-{i + 1:02d}",
            "kind": "text",
            "timeline_start": round(float(v.get("at", 0)), 3),
            "timeline_end": round(float(v.get("at", 0)) + float(v.get("duration", 2.5)), 3),
            "text": v.get("text", ""),
            "position": v.get("position", "center"),
            "label": str(v.get("text", "Text"))[:30] or "Text",
        }
        for i, v in enumerate(plan.get("text_overlays", []))
    ]
    sfx_clips = []
    if plan.get("overlay_audio_at") is not None:
        at = float(plan["overlay_audio_at"])
        sfx_clips.append({
            "id": "sfx-01",
            "kind": "sfx",
            "timeline_start": round(at, 3),
            "timeline_end": round(at + 1.0, 3),
            "label": "Uploaded SFX",
        })

    return {
        "duration": round(max(0.1, cursor), 3),
        "tracks": [
            {"id": "video-1", "kind": "video", "label": "Video 1", "clips": video_clips},
            {"id": "text-1", "kind": "text", "label": "Text", "clips": text_clips},
            {"id": "voice-1", "kind": "voiceover", "label": "Voiceover", "clips": voice_clips},
            {"id": "sfx-1", "kind": "sfx", "label": "SFX", "clips": sfx_clips},
        ],
    }


def sanitize_saved_plan(plan: dict[str, Any], scenes: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    candidate = dict(plan)
    timeline = candidate.get("timeline", {})
    tracks = timeline.get("tracks", []) if isinstance(timeline, dict) else []

    video = next((t for t in tracks if t.get("kind") == "video"), None)
    if video:
        clips = sorted(video.get("clips", []), key=lambda clip: float(clip.get("timeline_start", 0)))
        candidate["segments"] = [
            {
                "clip_id": clip.get("id"),
                "scene_id": clip.get("scene_id"),
                "start": clip.get("source_start"),
                "end": clip.get("source_end"),
                "reason": clip.get("reason", "Manual timeline edit"),
            }
            for clip in clips
        ]

    text_track = next((t for t in tracks if t.get("kind") == "text"), None)
    if text_track is not None:
        candidate["text_overlays"] = [
            {
                "id": clip.get("id"),
                "at": clip.get("timeline_start", 0),
                "duration": max(0.25, float(clip.get("timeline_end", 0)) - float(clip.get("timeline_start", 0))),
                "text": clip.get("text", clip.get("label", "")),
                "position": clip.get("position", "center"),
            }
            for clip in text_track.get("clips", [])
        ]

    voice_track = next((t for t in tracks if t.get("kind") == "voiceover"), None)
    if voice_track is not None:
        candidate["voiceover"] = [
            {"id": clip.get("id"), "at": clip.get("timeline_start", 0), "text": clip.get("text", "")}
            for clip in voice_track.get("clips", [])
        ]

    sfx_track = next((t for t in tracks if t.get("kind") == "sfx"), None)
    if sfx_track is not None:
        clips = sorted(sfx_track.get("clips", []), key=lambda clip: float(clip.get("timeline_start", 0)))
        candidate["overlay_audio_at"] = clips[0].get("timeline_start") if clips else None

    return sanitize_plan(
        candidate,
        scenes,
        str(config.get("narration_text", "")),
        config.get("overlay_audio_at"),
        preserve_order=True,
    )

def aspect_filter(aspect_ratio: str) -> str:
    targets = {
        "9:16": (1080, 1920),
        "16:9": (1920, 1080),
        "1:1": (1080, 1080),
        "4:5": (1080, 1350),
    }
    if aspect_ratio not in targets:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    w, h = targets[aspect_ratio]
    return f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"


def render_cuts(
    input_path: Path,
    selected: list[dict[str, Any]],
    folder: Path,
    keep_original_audio: bool,
    aspect_ratio: str,
) -> Path:
    pieces = folder / "pieces"
    if pieces.exists():
        for old in pieces.glob("*.mp4"):
            old.unlink(missing_ok=True)
    pieces.mkdir(exist_ok=True)
    concat_lines = []
    source_has_audio = has_audio(input_path)
    for i, seg in enumerate(selected):
        piece = pieces / f"part-{i:03d}.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{seg['start']:.3f}",
            "-to", f"{seg['end']:.3f}",
            "-i", str(input_path),
            "-vf", aspect_filter(aspect_ratio),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        ]
        if keep_original_audio and source_has_audio:
            cmd += ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]
        else:
            cmd += ["-an"]
        cmd += ["-movflags", "+faststart", str(piece)]
        run(cmd)
        concat_lines.append(f"file '{piece.as_posix()}'")

    manifest = folder / "concat.txt"
    manifest.write_text("\n".join(concat_lines), encoding="utf-8")
    out = folder / "cuts.mp4"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(manifest), "-c", "copy", str(out)])
    return out


def tts(text: str, voice: str, out: Path) -> None:
    from openai import OpenAI

    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required for voiceover generation")
    client = OpenAI()
    response = client.audio.speech.create(
        model=os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
        voice=voice,
        input=text,
    )
    response.stream_to_file(out)


def escape_drawtext(text: str) -> str:
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("%", "\\%")


def _caption_style(style: str) -> str:
    if style == "minimal":
        return "FontName=DejaVu Sans,FontSize=18,Outline=1,Shadow=0,Alignment=2,MarginV=50"
    if style == "clean":
        return "FontName=DejaVu Sans,FontSize=22,Bold=1,Outline=2,Shadow=0,Alignment=2,MarginV=58"
    return "FontName=DejaVu Sans,FontSize=28,Bold=1,Outline=3,Shadow=1,Alignment=2,MarginV=72"


def finish_render(
    cuts: Path,
    output: Path,
    folder: Path,
    plan: dict[str, Any],
    transcript: list[dict[str, Any]],
    burn_captions: bool,
    voice: str,
    overlay_audio_path: str | None,
    keep_original_audio: bool,
    caption_style: str,
) -> None:
    video_filters = []
    srt = folder / "captions.srt"
    if burn_captions and create_srt(transcript, plan["segments"], srt):
        escaped_srt = str(srt).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        video_filters.append(f"subtitles='{escaped_srt}':force_style='{_caption_style(caption_style)}'")

    headline = plan.get("headline", "").strip()
    font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if headline:
        video_filters.append(
            "drawtext="
            f"fontfile='{font}':text='{escape_drawtext(headline)}':"
            "fontcolor=white:fontsize=h/18:borderw=3:bordercolor=black@0.78:"
            "x=(w-text_w)/2:y=h*0.08:enable='between(t,0,3.5)'"
        )

    for item in plan.get("text_overlays", []):
        at = float(item.get("at", 0.0))
        end = at + float(item.get("duration", 2.5))
        position = item.get("position", "center")
        y = {"top": "h*0.12", "center": "(h-text_h)/2", "bottom": "h*0.78"}.get(position, "(h-text_h)/2")
        text = escape_drawtext(str(item.get("text", "")))
        if not text:
            continue
        video_filters.append(
            "drawtext="
            f"fontfile='{font}':text='{text}':fontcolor=white:fontsize=h/16:"
            f"borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y={y}:enable='between(t,{at:.3f},{end:.3f})'"
        )

    voice_inputs: list[tuple[Path, int, float]] = []
    for i, item in enumerate(plan.get("voiceover", [])):
        clip = folder / f"voice-{i:02d}.mp3"
        tts(item["text"], voice, clip)
        duration = ffprobe_duration(clip)
        voice_inputs.append((clip, int(round(float(item["at"]) * 1000)), duration))

    overlay: tuple[Path, int] | None = None
    if overlay_audio_path and Path(overlay_audio_path).exists() and plan.get("overlay_audio_at") is not None:
        overlay = (Path(overlay_audio_path), int(round(float(plan["overlay_audio_at"]) * 1000)))

    cmd = ["ffmpeg", "-y", "-i", str(cuts)]
    for clip, _delay, _duration in voice_inputs:
        cmd += ["-i", str(clip)]
    if overlay:
        cmd += ["-i", str(overlay[0])]

    filter_parts = []
    if video_filters:
        filter_parts.append(f"[0:v]{','.join(video_filters)}[vout]")

    audio_labels = []
    base_audio = has_audio(cuts) and keep_original_audio
    if base_audio:
        current = "[0:a]"
        if voice_inputs:
            for i, (_clip, delay_ms, duration) in enumerate(voice_inputs):
                start = delay_ms / 1000.0
                end = start + duration
                out_label = f"[duck{i}]"
                filter_parts.append(f"{current}volume=0.28:enable='between(t,{start:.3f},{end:.3f})'{out_label}")
                current = out_label
        filter_parts.append(f"{current}anull[abase]")
        audio_labels.append("[abase]")

    input_index = 1
    for i, (_clip, delay, _duration) in enumerate(voice_inputs):
        label = f"[vo{i}]"
        filter_parts.append(f"[{input_index}:a]adelay={delay}|{delay},volume=1.0{label}")
        audio_labels.append(label)
        input_index += 1

    if overlay:
        label = "[sfx]"
        filter_parts.append(f"[{input_index}:a]adelay={overlay[1]}|{overlay[1]},volume=0.92{label}")
        audio_labels.append(label)

    if len(audio_labels) >= 2:
        filter_parts.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest:dropout_transition=2[aout]")
    elif len(audio_labels) == 1:
        filter_parts.append(f"{audio_labels[0]}anull[aout]")

    if filter_parts:
        cmd += ["-filter_complex", ";".join(filter_parts)]
        cmd += ["-map", "[vout]" if video_filters else "0:v"]
        if audio_labels:
            cmd += ["-map", "[aout]"]
    else:
        cmd += ["-map", "0:v"]
        if has_audio(cuts):
            cmd += ["-map", "0:a?"]

    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    if audio_labels or has_audio(cuts):
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += ["-movflags", "+faststart", "-t", f"{ffprobe_duration(cuts):.3f}", str(output)]
    run(cmd)


def _load_frames(folder: Path) -> list[dict[str, Any]]:
    scenes = read_json(folder / "scenes.json", []) or []
    by_id = {int(s["id"]): s for s in scenes}
    frames = []
    for p in sorted((folder / "frames").glob("scene-*.jpg")) if (folder / "frames").exists() else []:
        try:
            sid = int(p.stem.split("-")[-1])
        except Exception:
            continue
        scene = by_id.get(sid)
        if not scene:
            continue
        mid = scene["start"] + (scene["end"] - scene["start"]) / 2
        frames.append({"scene_id": sid, "time": round(mid, 3), "path": p})
    return frames


def analyze_and_plan_job(job_id: str, input_path: Path, config: dict[str, Any], write_status: StatusWriter) -> None:
    folder = input_path.parent
    try:
        write_status(job_id, {"state": "analyzing", "progress": 10, "message": "Reading video structure"})
        duration = ffprobe_duration(input_path)
        scenes = detect_scenes(input_path, duration)
        write_json(folder / "scenes.json", scenes)

        write_status(job_id, {"progress": 24, "message": f"Detected {len(scenes)} scene(s)"})
        frames = extract_frames(input_path, scenes, folder)
        audio = extract_audio(input_path, folder)

        write_status(job_id, {"progress": 38, "message": "Transcribing speech"})
        transcript = transcribe(audio)
        write_json(folder / "transcript.json", transcript)

        write_status(job_id, {"state": "planning", "progress": 56, "message": "AI is building the first timeline"})
        plan = ai_plan(
            config["edit_prompt"],
            config.get("narration_text", ""),
            scenes,
            transcript,
            frames,
            config.get("overlay_audio_at"),
        )
        write_json(plan_path(job_id), plan)

        write_status(job_id, {
            "state": "planned",
            "progress": 100,
            "message": "Timeline ready to review",
            "plan_url": f"/api/jobs/{job_id}/plan",
            "manifest_url": f"/api/jobs/{job_id}/manifest",
            "summary": plan.get("summary", ""),
            "timeline_duration": plan.get("timeline", {}).get("duration", 0),
        })
    except Exception as exc:
        (folder / "error.txt").write_text(str(exc), encoding="utf-8")
        write_status(job_id, {"state": "error", "progress": 100, "message": str(exc)[-1800:]})


def replan_existing_job(job_id: str, config: dict[str, Any], write_status: StatusWriter) -> None:
    folder = job_dir(job_id)
    try:
        scenes = read_json(folder / "scenes.json", []) or []
        transcript = read_json(folder / "transcript.json", []) or []
        frames = _load_frames(folder)
        plan = ai_plan(
            config["edit_prompt"],
            config.get("narration_text", ""),
            scenes,
            transcript,
            frames,
            config.get("overlay_audio_at"),
        )
        write_json(plan_path(job_id), plan)
        write_status(job_id, {
            "state": "planned",
            "progress": 100,
            "message": "AI revision ready",
            "summary": plan.get("summary", ""),
            "timeline_duration": plan.get("timeline", {}).get("duration", 0),
        })
    except Exception as exc:
        (folder / "error.txt").write_text(str(exc), encoding="utf-8")
        write_status(job_id, {"state": "error", "progress": 100, "message": str(exc)[-1800:]})


def render_existing_job(job_id: str, config: dict[str, Any], write_status: StatusWriter) -> None:
    folder = job_dir(job_id)
    input_path = next((p for p in folder.glob("input.*") if p.is_file()), None)
    if not input_path:
        write_status(job_id, {"state": "error", "progress": 100, "message": "Source video is missing"})
        return
    try:
        plan = read_json(plan_path(job_id), None)
        if not plan:
            raise RuntimeError("Edit plan is missing")
        transcript = read_json(folder / "transcript.json", []) or []

        write_status(job_id, {"state": "rendering", "progress": 72, "message": "Cutting selected clips"})
        cuts = render_cuts(
            input_path,
            plan["segments"],
            folder,
            bool(config.get("keep_original_audio", True)),
            str(config.get("aspect_ratio", "original")),
        )

        write_status(job_id, {"progress": 86, "message": "Mixing captions, voice and sound"})
        output = folder / "output.mp4"
        finish_render(
            cuts=cuts,
            output=output,
            folder=folder,
            plan=plan,
            transcript=transcript,
            burn_captions=bool(config.get("burn_captions", True)),
            voice=str(config.get("voice", "alloy")),
            overlay_audio_path=config.get("overlay_audio_path"),
            keep_original_audio=bool(config.get("keep_original_audio", True)),
            caption_style=str(config.get("caption_style", "social")),
        )

        write_status(job_id, {
            "state": "done",
            "progress": 100,
            "message": "Render complete",
            "download_url": f"/api/jobs/{job_id}/download",
            "plan_url": f"/api/jobs/{job_id}/plan",
            "summary": plan.get("summary", ""),
        })
    except Exception as exc:
        (folder / "error.txt").write_text(str(exc), encoding="utf-8")
        write_status(job_id, {"state": "error", "progress": 100, "message": str(exc)[-1800:]})
