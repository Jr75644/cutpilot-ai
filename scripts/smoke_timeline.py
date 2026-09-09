"""Fast no-media smoke test for timeline save/render ordering."""
from app.processor import sanitize_plan, sanitize_saved_plan

scenes = [
    {"id": 0, "start": 0.0, "end": 4.0, "duration": 4.0},
    {"id": 1, "start": 4.0, "end": 9.0, "duration": 5.0},
    {"id": 2, "start": 9.0, "end": 14.0, "duration": 5.0},
]
plan = sanitize_plan({
    "summary": "smoke",
    "segments": [
        {"scene_id": 0, "start": 0, "end": 4, "reason": "a"},
        {"scene_id": 1, "start": 4, "end": 9, "reason": "b"},
        {"scene_id": 2, "start": 9, "end": 14, "reason": "c"},
    ],
    "voiceover": [], "text_overlays": [], "overlay_audio_at": None,
}, scenes, "", None)
video = plan["timeline"]["tracks"][0]
video["clips"] = [
    {**video["clips"][2], "timeline_start": 0, "timeline_end": 5},
    {**video["clips"][1], "id": "split-a", "source_start": 4, "source_end": 6.5, "timeline_start": 5, "timeline_end": 7.5},
    {**video["clips"][1], "id": "split-b", "source_start": 6.5, "source_end": 9, "timeline_start": 7.5, "timeline_end": 10},
    {**video["clips"][0], "timeline_start": 10, "timeline_end": 14},
]
saved = sanitize_saved_plan(plan, scenes, {"narration_text": "", "overlay_audio_at": None})
assert [segment["scene_id"] for segment in saved["segments"]] == [2, 1, 1, 0]
assert saved["segments"][1]["clip_id"] == "split-a"
assert saved["segments"][2]["start"] == 6.5
assert saved["timeline"]["duration"] == 14.0
print("timeline smoke test passed")
