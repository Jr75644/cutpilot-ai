# CutPilot roadmap

## Phase 1 — AI editor foundation ✅

- React/TypeScript NLE workspace
- upload/source preview
- AI scene + transcript + frame analysis
- structured edit plan
- Video / Text / Voiceover / SFX tracks
- project inspector
- iterative AI re-planning
- aspect ratios, captions, narration, SFX
- explicit review before rendering

## Phase 2 — interactive timeline ✅ / in progress

Completed in v0.3:

- draggable/reorderable video clips
- draggable text, voiceover, SFX timing
- video trim handles constrained to scene bounds
- text duration trim handles
- split at playhead
- delete selected clip
- undo/redo history
- timeline zoom
- scrub/playhead synced to cut-aware source preview
- keyboard editing shortcuts
- debounced autosave
- timeline becomes the backend/render source of truth
- stable clip IDs across save validation

Next inside Phase 2:

- true audio waveform extraction/rendering
- timeline snapping to cuts, playhead, speech boundaries, and neighboring clips
- duplicate clip command
- multi-select / range select
- copy/paste
- project version snapshots beyond in-session undo history
- live preview composition for overlays/audio before final render

## Phase 3 — stronger automatic editing

- automatic silence removal using transcript/audio analysis
- filler-word removal
- word-level transcript editing (delete words = cut footage)
- semantic scene memory ("the hallway", "when he turns around")
- auto reframing / face and subject tracking for 9:16
- user-media B-roll suggestions
- beat detection and optional music synchronization
- audio cleanup/loudness normalization
- editable ducking envelopes and volume keyframes
- transition/effect library
- animated word-highlight caption templates

## Phase 4 — production platform

- accounts/authentication
- projects + folders
- resumable direct-to-object-storage uploads
- S3/R2 media storage + signed URLs
- Postgres metadata
- Redis + render worker queue
- WebSocket/SSE job progress
- render quality presets
- share links/cloud exports
- usage and cost controls
- collaboration

## Phase 5 — AI-native timeline commands

Move from full timeline re-plans to explicit previewable patch operations:

- “hold on the hallway door two seconds longer”
- “remove every pause over 0.7 seconds”
- “put the Ring sound exactly when the notification appears”
- “make the first three seconds stronger for TikTok”
- “move that narration after he turns around”
- “undo only the last AI change”

Every AI operation should be human-readable, previewable, undoable, and apply to the exact same timeline operations used by manual editing.
