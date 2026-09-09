# CutPilot roadmap

## Phase 1 — editor foundation (current)

- React/TypeScript NLE-style workspace
- import/source preview
- AI scene + transcript analysis
- structured edit plan
- multi-track timeline visualization
- project inspector
- iterative AI re-plan
- aspect ratios + captions + narration + one SFX layer
- explicit review before rendering

## Phase 2 — make the timeline truly editable

- draggable/reorderable video clips
- trim handles with snap-to-scene/speech boundaries
- split/delete/duplicate actions
- undo/redo history
- draggable text, voice, and SFX clips
- waveform thumbnails
- timeline zoom + playhead scrubbing synced to preview
- non-destructive project save/versioning

## Phase 3 — stronger automatic editing

- silence/filler-word removal
- word-level transcript editing (delete words = cut footage)
- auto reframing / face & subject tracking for 9:16
- cutaway/B-roll suggestions from user-owned media
- beat detection and optional music synchronization
- smart audio cleanup, loudness normalization, ducking envelopes
- transition/effect library
- caption templates with word highlighting

## Phase 4 — production platform

- accounts/authentication
- projects + folders + autosave
- resumable uploads
- S3/R2 storage
- background worker queue
- render presets / quality choices
- share links and cloud exports
- usage/cost controls
- project collaboration

## Phase 5 — AI-native editing assistant

- conversational timeline operations such as:
  - “hold on the hallway door for two seconds longer”
  - “remove every pause over 0.7 sec”
  - “put the Ring sound exactly when the notification appears”
  - “make the first 3 seconds stronger for TikTok”
  - “keep my wording but make the narration sound more uneasy”
- AI actions returned as patch operations so every change is previewable and undoable
- scene memory so the editor can refer to visual moments semantically (“the hallway,” “when he turns around,” “the red car”)
