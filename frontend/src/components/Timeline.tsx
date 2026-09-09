import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { moveClip, trimClip } from '../timelineOps';
import type { EditPlan, TimelineClip } from '../types';

interface SceneBounds { id: number; start: number; end: number; }

interface Props {
  plan: EditPlan | null;
  selectedClipId: string | null;
  scenes: SceneBounds[];
  playhead: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  onSelectClip: (clip: TimelineClip) => void;
  onPlanChange: (next: EditPlan) => void;
  onCheckpoint: () => void;
  onPlayheadChange: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onZoomChange: (zoom: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSplit: () => void;
  onDelete: () => void;
}

type DragMode = 'move' | 'trim-start' | 'trim-end';
interface DragState {
  pointerId: number;
  mode: DragMode;
  trackId: string;
  clipId: string;
  originX: number;
  originPlan: EditPlan;
  width: number;
  duration: number;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Timeline({
  plan,
  selectedClipId,
  scenes,
  playhead,
  zoom,
  canUndo,
  canRedo,
  onSelectClip,
  onPlanChange,
  onCheckpoint,
  onPlayheadChange,
  onPlayingChange,
  onZoomChange,
  onUndo,
  onRedo,
  onSplit,
  onDelete,
}: Props) {
  const duration = Math.max(plan?.timeline?.duration ?? 0, 1);
  const markCount = Math.max(7, Math.ceil(7 * zoom));
  const marks = Array.from({ length: markCount }, (_, i) => (duration / (markCount - 1)) * i);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [scrubPointer, setScrubPointer] = useState<number | null>(null);

  const sceneMap = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const selected = plan?.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId) ?? null;

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, trackId: string, clip: TimelineClip, mode: DragMode) => {
    if (!plan || !canvasRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    onPlayingChange(false);
    onSelectClip(clip);
    onCheckpoint();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      mode,
      trackId,
      clipId: clip.id,
      originX: event.clientX,
      originPlan: structuredClone(plan),
      width: Math.max(1, canvasRef.current.getBoundingClientRect().width),
      duration,
    });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = ((event.clientX - drag.originX) / drag.width) * drag.duration;
    let next: EditPlan;
    if (drag.mode === 'move') {
      next = moveClip(drag.originPlan, drag.trackId, drag.clipId, delta);
    } else {
      const clip = drag.originPlan.timeline.tracks.find((track) => track.id === drag.trackId)?.clips.find((item) => item.id === drag.clipId);
      const scene = clip?.scene_id === undefined ? undefined : sceneMap.get(clip.scene_id);
      next = trimClip(drag.originPlan, drag.trackId, drag.clipId, drag.mode === 'trim-start' ? 'start' : 'end', delta, scene);
    }
    onPlanChange(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDrag(null);
  };

  const scrubAt = (event: ReactPointerEvent<HTMLElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    onPlayheadChange((x / rect.width) * duration);
  };

  const beginScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPlayingChange(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubPointer(event.pointerId);
    scrubAt(event);
  };

  return (
    <section className="timeline-panel">
      <div className="timeline-toolbar">
        <div className="timeline-tools">
          <button className="tool active" title="Select / move">↖</button>
          <button className="tool" title="Split at playhead" onClick={onSplit} disabled={!selected || selected.kind !== 'video'}>✂</button>
          <button className="tool" title="Delete selected" onClick={onDelete} disabled={!selected}>⌫</button>
          <button className="tool" title="Undo" onClick={onUndo} disabled={!canUndo}>↶</button>
          <button className="tool" title="Redo" onClick={onRedo} disabled={!canRedo}>↷</button>
          <span className="timeline-divider" />
          <button className="tool" onClick={() => onZoomChange(Math.max(0.75, zoom - 0.25))}>−</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="tool" onClick={() => onZoomChange(Math.min(4, zoom + 0.25))}>＋</button>
        </div>
        <div className="timeline-time"><b>{fmt(playhead)}</b><span>/</span>{fmt(duration)} total</div>
      </div>

      <div className="timeline-body">
        <div className="track-labels">
          <div className="ruler-spacer" />
          {(plan?.timeline?.tracks ?? [
            { id: 'video', kind: 'video', label: 'Video 1', clips: [] },
            { id: 'text', kind: 'text', label: 'Text', clips: [] },
            { id: 'voice', kind: 'voiceover', label: 'Voiceover', clips: [] },
            { id: 'sfx', kind: 'sfx', label: 'SFX', clips: [] },
          ]).map((track) => (
            <div className="track-label" key={track.id}>
              <span className={`track-dot ${track.kind}`} />
              <b>{track.label}</b>
              <span className="track-icons">◉ ◇</span>
            </div>
          ))}
        </div>

        <div className="tracks-scroll">
          <div ref={canvasRef} className="timeline-canvas" style={{ width: `${Math.max(1, zoom) * 100}%` }}>
            <div
              className="timeline-ruler"
              onPointerDown={beginScrub}
              onPointerMove={(event) => scrubPointer === event.pointerId && scrubAt(event)}
              onPointerUp={(event) => scrubPointer === event.pointerId && setScrubPointer(null)}
              onPointerCancel={() => setScrubPointer(null)}
            >
              {marks.map((mark, i) => (
                <span key={i} style={{ left: `${(mark / duration) * 100}%` }}>{fmt(mark)}</span>
              ))}
            </div>
            <div className="playhead" style={{ left: `${Math.min(100, Math.max(0, (playhead / duration) * 100))}%` }}><span /></div>
            {(plan?.timeline?.tracks ?? []).map((track) => (
              <div className="track-row" key={track.id}>
                {track.clips.map((clip) => {
                  const left = (clip.timeline_start / duration) * 100;
                  const width = Math.max(((clip.timeline_end - clip.timeline_start) / duration) * 100, 0.7);
                  const trimmable = clip.kind === 'video' || clip.kind === 'text';
                  return (
                    <button
                      key={clip.id}
                      className={`timeline-clip ${clip.kind} ${selectedClipId === clip.id ? 'selected' : ''} ${drag?.clipId === clip.id ? 'dragging' : ''}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onPointerDown={(event) => beginDrag(event, track.id, clip, 'move')}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={() => setDrag(null)}
                      title={clip.reason || clip.text || clip.label}
                    >
                      {trimmable && <span className="trim-handle start" onPointerDown={(event) => beginDrag(event, track.id, clip, 'trim-start')} />}
                      <span className="clip-content">
                        <strong>{clip.label}</strong>
                        <small>{(clip.timeline_end - clip.timeline_start).toFixed(1)}s</small>
                      </span>
                      {(clip.kind === 'voiceover' || clip.kind === 'sfx') && <span className="waveform-mini" />}
                      {trimmable && <span className="trim-handle end" onPointerDown={(event) => beginDrag(event, track.id, clip, 'trim-end')} />}
                    </button>
                  );
                })}
              </div>
            ))}
            {!plan && <div className="timeline-empty"><span>AI timeline will appear here after analysis</span></div>}
          </div>
        </div>
      </div>
    </section>
  );
}
