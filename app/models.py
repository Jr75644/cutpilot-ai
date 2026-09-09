from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class SegmentPlan(BaseModel):
    scene_id: int
    start: float
    end: float
    reason: str = "AI selected"


class VoiceoverPlan(BaseModel):
    at: float = Field(ge=0)
    text: str


class TextOverlayPlan(BaseModel):
    at: float = Field(ge=0)
    duration: float = Field(default=2.5, gt=0)
    text: str
    position: Literal["top", "center", "bottom"] = "center"


class AIEditPlan(BaseModel):
    summary: str
    segments: list[SegmentPlan]
    headline: str = ""
    voiceover: list[VoiceoverPlan] = Field(default_factory=list)
    text_overlays: list[TextOverlayPlan] = Field(default_factory=list)
    overlay_audio_at: float | None = None


class ReplanRequest(BaseModel):
    edit_prompt: str
    narration_text: str = ""
    voice: str | None = None


class TimelinePatch(BaseModel):
    plan: dict


class RenderRequest(BaseModel):
    aspect_ratio: Literal["original", "9:16", "16:9", "1:1", "4:5"] | None = None
    caption_style: Literal["clean", "social", "minimal"] | None = None
