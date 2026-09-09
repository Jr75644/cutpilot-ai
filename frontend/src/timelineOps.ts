import type { EditPlan, TimelineClip, TimelineTrack } from './types';

export const MIN_CLIP = 0.12;

export function clonePlan(plan: EditPlan): EditPlan {
  return structuredClone(plan);
}

export function getTrack(plan: EditPlan, kind: TimelineTrack['kind']) {
  return plan.timeline.tracks.find((item) => item.kind === kind);
}

export function clipById(plan: EditPlan | null, id: string | null): TimelineClip | null {
  if (!plan || !id) return null;
  for (const timelineTrack of plan.timeline.tracks) {
    const clip = timelineTrack.clips.find((item) => item.id === id);
    if (clip) return clip;
  }
  return null;
}

export function normalizePlan(plan: EditPlan): EditPlan {
  const next = clonePlan(plan);
  const video = getTrack(next, 'video');
  if (video) {
    video.clips.sort((a, b) => a.timeline_start - b.timeline_start);
    let cursor = 0;
    video.clips = video.clips.map((clip) => {
      const sourceStart = clip.source_start ?? 0;
      const sourceEnd = Math.max(sourceStart + MIN_CLIP, clip.source_end ?? sourceStart + MIN_CLIP);
      const duration = sourceEnd - sourceStart;
      const normalized = {
        ...clip,
        source_start: sourceStart,
        source_end: sourceEnd,
        timeline_start: cursor,
        timeline_end: cursor + duration,
      };
      cursor += duration;
      return normalized;
    });
    next.segments = video.clips.map((clip) => ({
      clip_id: clip.id,
      scene_id: clip.scene_id ?? 0,
      start: clip.source_start ?? 0,
      end: clip.source_end ?? MIN_CLIP,
      reason: clip.reason ?? 'Timeline edit',
    }));
  }

  const videoDuration = getTrack(next, 'video')?.clips.at(-1)?.timeline_end ?? 0.1;
  for (const timelineTrack of next.timeline.tracks) {
    if (timelineTrack.kind === 'video') continue;
    timelineTrack.clips = timelineTrack.clips.map((clip) => {
      const length = Math.max(0.05, clip.timeline_end - clip.timeline_start);
      const start = Math.max(0, Math.min(clip.timeline_start, Math.max(0, videoDuration - Math.min(length, videoDuration))));
      return { ...clip, timeline_start: start, timeline_end: Math.min(videoDuration, start + length) };
    });
  }

  const textTrack = getTrack(next, 'text');
  next.text_overlays = (textTrack?.clips ?? [])
    .slice()
    .sort((a, b) => a.timeline_start - b.timeline_start)
    .map((clip) => ({
      id: clip.id,
      at: clip.timeline_start,
      duration: Math.max(0.25, clip.timeline_end - clip.timeline_start),
      text: clip.text ?? clip.label,
      position: clip.position ?? 'center',
    }));

  const voiceTrack = getTrack(next, 'voiceover');
  next.voiceover = (voiceTrack?.clips ?? [])
    .slice()
    .sort((a, b) => a.timeline_start - b.timeline_start)
    .map((clip) => ({ id: clip.id, at: clip.timeline_start, text: clip.text ?? clip.label }));

  const sfxTrack = getTrack(next, 'sfx');
  const firstSfx = sfxTrack?.clips.slice().sort((a, b) => a.timeline_start - b.timeline_start)[0];
  next.overlay_audio_at = firstSfx ? firstSfx.timeline_start : null;

  next.timeline.duration = Math.max(0.1, videoDuration);
  return next;
}

function withClip(
  plan: EditPlan,
  trackId: string,
  clipId: string,
  updater: (clip: TimelineClip) => TimelineClip,
): EditPlan {
  const next = clonePlan(plan);
  const timelineTrack = next.timeline.tracks.find((item) => item.id === trackId);
  if (!timelineTrack) return next;
  timelineTrack.clips = timelineTrack.clips.map((clip) => clip.id === clipId ? updater(clip) : clip);
  return normalizePlan(next);
}

export function moveClip(plan: EditPlan, trackId: string, clipId: string, delta: number): EditPlan {
  const original = clonePlan(plan);
  const timelineTrack = original.timeline.tracks.find((item) => item.id === trackId);
  const selected = timelineTrack?.clips.find((clip) => clip.id === clipId);
  if (!timelineTrack || !selected) return original;

  if (timelineTrack.kind === 'video') {
    const remaining = timelineTrack.clips.filter((clip) => clip.id !== clipId);
    const targetCenter = (selected.timeline_start + selected.timeline_end) / 2 + delta;
    let insertAt = remaining.length;
    for (let i = 0; i < remaining.length; i += 1) {
      const center = (remaining[i].timeline_start + remaining[i].timeline_end) / 2;
      if (targetCenter < center) {
        insertAt = i;
        break;
      }
    }
    remaining.splice(insertAt, 0, selected);
    timelineTrack.clips = remaining;
    return normalizePlan(original);
  }

  const length = selected.timeline_end - selected.timeline_start;
  const videoDuration = getTrack(original, 'video')?.clips.at(-1)?.timeline_end ?? original.timeline.duration;
  const start = Math.max(0, Math.min(selected.timeline_start + delta, Math.max(0, videoDuration - length)));
  return withClip(original, trackId, clipId, (clip) => ({
    ...clip,
    timeline_start: start,
    timeline_end: start + length,
  }));
}

export function trimClip(
  plan: EditPlan,
  trackId: string,
  clipId: string,
  edge: 'start' | 'end',
  delta: number,
  sceneBounds?: { start: number; end: number },
): EditPlan {
  const timelineTrack = plan.timeline.tracks.find((item) => item.id === trackId);
  const selected = timelineTrack?.clips.find((clip) => clip.id === clipId);
  if (!timelineTrack || !selected) return clonePlan(plan);

  if (timelineTrack.kind === 'video') {
    const sourceStart = selected.source_start ?? 0;
    const sourceEnd = selected.source_end ?? sourceStart + MIN_CLIP;
    const minSource = sceneBounds?.start ?? 0;
    const maxSource = sceneBounds?.end ?? Number.POSITIVE_INFINITY;
    return withClip(plan, trackId, clipId, (clip) => {
      if (edge === 'start') {
        const nextStart = Math.min(sourceEnd - MIN_CLIP, Math.max(minSource, sourceStart + delta));
        return { ...clip, source_start: nextStart };
      }
      const nextEnd = Math.max(sourceStart + MIN_CLIP, Math.min(maxSource, sourceEnd + delta));
      return { ...clip, source_end: nextEnd };
    });
  }

  if (timelineTrack.kind === 'text') {
    return withClip(plan, trackId, clipId, (clip) => {
      if (edge === 'start') {
        const nextStart = Math.min(clip.timeline_end - 0.25, Math.max(0, clip.timeline_start + delta));
        return { ...clip, timeline_start: nextStart };
      }
      const videoDuration = getTrack(plan, 'video')?.clips.at(-1)?.timeline_end ?? plan.timeline.duration;
      return { ...clip, timeline_end: Math.min(videoDuration, Math.max(clip.timeline_start + 0.25, clip.timeline_end + delta)) };
    });
  }

  return clonePlan(plan);
}

export function splitVideoClip(plan: EditPlan, clipId: string, at: number): { plan: EditPlan; selectedId: string | null } {
  const next = clonePlan(plan);
  const video = getTrack(next, 'video');
  if (!video) return { plan: next, selectedId: null };
  const index = video.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return { plan: next, selectedId: null };
  const clip = video.clips[index];
  if (at <= clip.timeline_start + MIN_CLIP || at >= clip.timeline_end - MIN_CLIP) {
    return { plan: next, selectedId: clip.id };
  }
  const sourceAt = (clip.source_start ?? 0) + (at - clip.timeline_start);
  const seed = Math.random().toString(36).slice(2, 7);
  const left: TimelineClip = { ...clip, id: `${clip.id}-a-${seed}`, label: `${clip.label} A`, source_end: sourceAt };
  const right: TimelineClip = { ...clip, id: `${clip.id}-b-${seed}`, label: `${clip.label} B`, source_start: sourceAt };
  video.clips.splice(index, 1, left, right);
  return { plan: normalizePlan(next), selectedId: right.id };
}

export function deleteClip(plan: EditPlan, clipId: string): EditPlan {
  const next = clonePlan(plan);
  for (const timelineTrack of next.timeline.tracks) {
    const index = timelineTrack.clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) continue;
    if (timelineTrack.kind === 'video' && timelineTrack.clips.length <= 1) return next;
    timelineTrack.clips.splice(index, 1);
    break;
  }
  return normalizePlan(next);
}

export function sourceTimeForTimeline(plan: EditPlan | null, at: number) {
  if (!plan) return null;
  const video = getTrack(plan, 'video');
  if (!video?.clips.length) return null;
  const clips = video.clips.slice().sort((a, b) => a.timeline_start - b.timeline_start);
  let index = clips.findIndex((clip) => at >= clip.timeline_start && at < clip.timeline_end);
  if (index < 0) index = at >= clips[clips.length - 1].timeline_end ? clips.length - 1 : 0;
  const clip = clips[index];
  const offset = Math.max(0, Math.min(clip.timeline_end - clip.timeline_start, at - clip.timeline_start));
  return { sourceTime: (clip.source_start ?? 0) + offset, clip, index, clips };
}
