from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR.parent / "data"))
JOBS_DIR = DATA_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

_JOB_RE = re.compile(r"^[a-f0-9]{12}$")


def validate_job_id(job_id: str) -> str:
    if not _JOB_RE.match(job_id):
        raise ValueError("Invalid job id")
    return job_id


def job_dir(job_id: str) -> Path:
    validate_job_id(job_id)
    return JOBS_DIR / job_id


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def status_path(job_id: str) -> Path:
    return job_dir(job_id) / "status.json"


def config_path(job_id: str) -> Path:
    return job_dir(job_id) / "config.json"


def plan_path(job_id: str) -> Path:
    return job_dir(job_id) / "plan.json"
