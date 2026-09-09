import { useEffect, useRef } from 'react';
import { sourceTimeForTimeline } from '../timelineOps';
import type { EditPlan } from '../types';

interface Props {
  src: string | null;
  aspectRatio: string;
  state: string;
  plan: EditPlan | null;
  playhead: number;
  playing: boolean;
  rendered: boolean;
  onPlayheadChange: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

function timecode(time: number) {
  const total = Math.max(0, time);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const frames = Math.floor((total % 1) * 30);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

export default function PreviewStage({
  src,
  aspectRatio,
  state,
  plan,
  playhead,
  playing,
  rendered,
  onPlayheadChange,
  onPlayingChange,
}: Props) {
  const ratioClass = `ratio-${aspectRatio.replace(':', 'x')}`;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeClipIndex = useRef(0);
  const duration = Math.max(plan?.timeline.duration ?? 0, 0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || playing) return;
    if (rendered) {
      if (Math.abs(video.currentTime - playhead) > 0.05) video.currentTime = Math.min(playhead, video.duration || playhead);
      return;
    }
    const located = sourceTimeForTimeline(plan, playhead);
    if (!located) return;
    activeClipIndex.current = located.index;
    if (Math.abs(video.currentTime - located.sourceTime) > 0.05) video.currentTime = located.sourceTime;
  }, [playhead, plan, playing, rendered, src]);

  useEffect(() => {
    if (playing) return;
    videoRef.current?.pause();
  }, [playing]);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (playing) {
      video.pause();
      onPlayingChange(false);
      return;
    }
    try {
      if (rendered) {
        video.currentTime = Math.min(playhead, video.duration || playhead);
      } else {
        const located = sourceTimeForTimeline(plan, playhead);
        if (located) {
          activeClipIndex.current = located.index;
          video.currentTime = located.sourceTime;
        }
      }
      await video.play();
      onPlayingChange(true);
    } catch {
      onPlayingChange(false);
    }
  };

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !playing) return;
    if (rendered) {
      onPlayheadChange(Math.min(video.currentTime, duration || video.duration));
      return;
    }
    const located = sourceTimeForTimeline(plan, playhead);
    const clips = located?.clips ?? [];
    const clip = clips[activeClipIndex.current];
    if (!clip) return;
    const sourceStart = clip.source_start ?? 0;
    const sourceEnd = clip.source_end ?? sourceStart;
    if (video.currentTime >= sourceEnd - 0.025) {
      const next = clips[activeClipIndex.current + 1];
      if (!next) {
        video.pause();
        onPlayingChange(false);
        onPlayheadChange(plan?.timeline.duration ?? clip.timeline_end);
        return;
      }
      activeClipIndex.current += 1;
      video.currentTime = next.source_start ?? 0;
      onPlayheadChange(next.timeline_start);
      return;
    }
    const timelineTime = clip.timeline_start + Math.max(0, video.currentTime - sourceStart);
    onPlayheadChange(Math.min(clip.timeline_end, timelineTime));
  };

  const step = (delta: number) => {
    onPlayingChange(false);
    onPlayheadChange(Math.max(0, Math.min(duration, playhead + delta)));
  };

  return (
    <section className="preview-stage panel-surface">
      <div className="preview-toolbar">
        <span>{rendered ? 'Rendered preview' : 'Timeline preview'}</span>
        <div><button>Fit</button><button>50%</button><button>⛶</button></div>
      </div>
      <div className="stage-canvas">
        <div className={`video-shell ${ratioClass}`}>
          {src ? (
            <video
              ref={videoRef}
              src={src}
              playsInline
              preload="metadata"
              onTimeUpdate={onTimeUpdate}
              onEnded={() => onPlayingChange(false)}
            />
          ) : (
            <div className="preview-empty">
              <div className="preview-mark">CP</div>
              <b>Drop in a video to start editing</b>
              <p>CutPilot will analyze scenes, speech and visual context.</p>
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <button onClick={() => step(-1 / 30)} title="Previous frame">◀</button>
        <button className="play" onClick={togglePlay} disabled={!src}>{playing ? 'Ⅱ' : '▶'}</button>
        <button onClick={() => step(1 / 30)} title="Next frame">▶</button>
        <div className="transport-time"><b>{timecode(playhead)}</b><span>/</span><span>{timecode(duration)}</span></div>
        <div className="transport-right"><span className="preview-mode">{state === 'done' ? 'EXPORT' : 'LIVE CUT'}</span></div>
      </div>
    </section>
  );
}
