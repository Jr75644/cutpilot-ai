"""Render-order smoke test using a tiny generated RGB source video."""
from pathlib import Path
import subprocess
import tempfile

from app.processor import render_cuts


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def pixel(path: Path, at: float) -> tuple[int, int, int]:
    proc = subprocess.run([
        "ffmpeg", "-loglevel", "error", "-ss", str(at), "-i", str(path),
        "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], check=True, capture_output=True)
    return tuple(proc.stdout[:3])  # type: ignore[return-value]


with tempfile.TemporaryDirectory() as temp:
    folder = Path(temp)
    source = folder / "source.mp4"
    run([
        "ffmpeg", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=4",
        "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=5",
        "-f", "lavfi", "-i", "color=c=green:s=160x90:r=30:d=5",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source),
    ])
    rendered = render_cuts(source, [
        {"scene_id": 2, "start": 9.0, "end": 14.0, "reason": "green first"},
        {"scene_id": 1, "start": 4.0, "end": 6.5, "reason": "blue A"},
        {"scene_id": 1, "start": 6.5, "end": 9.0, "reason": "blue B"},
        {"scene_id": 0, "start": 0.0, "end": 4.0, "reason": "red last"},
    ], folder, False, "original")
    green, blue, red = pixel(rendered, 1), pixel(rendered, 6), pixel(rendered, 12)
    assert green[1] > green[0] and green[1] > green[2], green
    assert blue[2] > blue[0] and blue[2] > blue[1], blue
    assert red[0] > red[1] and red[0] > red[2], red
    print("ffmpeg reorder render smoke test passed")
