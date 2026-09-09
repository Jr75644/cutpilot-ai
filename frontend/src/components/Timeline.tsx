import type { EditPlan, TimelineClip } from '../types';

interface Props {
  plan: EditPlan | null;
  selectedClipId: string | null;
  onSelectClip: (clip: TimelineClip) => void;
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Timeline({ plan, selectedClipId, onSelectClip }: Props) {
  const duration = Math.max(plan?.timeline?.duration ?? 0, 1);
  const marks = Array.from({ length: 7 }, (_, i) => (duration / 6) * i);

  return (
    <section className="timeline-panel">
      <div className="timeline-toolbar">
        <div className="timeline-tools">
          <button className="tool active" title="Select">↖</button>
          <button className="tool" title="Split">✂</button>
          <button className="tool" title="Undo">↶</button>
          <button className="tool" title="Redo">↷</button>
          <span className="timeline-divider" />
          <button className="tool">−</button>
          <span className="zoom-label">100%</span>
          <button className="tool">＋</button>
        </div>
        <div className="timeline-time">{fmt(duration)} total</div>
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

        <div className="tracks-area">
          <div className="timeline-ruler">
            {marks.map((mark, i) => (
              <span key={i} style={{ left: `${(mark / duration) * 100}%` }}>{fmt(mark)}</span>
            ))}
          </div>
          <div className="playhead" style={{ left: '2%' }}><span /></div>
          {(plan?.timeline?.tracks ?? []).map((track) => (
            <div className="track-row" key={track.id}>
              {track.clips.map((clip) => {
                const left = (clip.timeline_start / duration) * 100;
                const width = Math.max(((clip.timeline_end - clip.timeline_start) / duration) * 100, 1.5);
                return (
                  <button
                    key={clip.id}
                    className={`timeline-clip ${clip.kind} ${selectedClipId === clip.id ? 'selected' : ''}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    onClick={() => onSelectClip(clip)}
                    title={clip.reason || clip.text || clip.label}
                  >
                    <span className="clip-grip" />
                    <strong>{clip.label}</strong>
                    {clip.kind === 'video' && <small>{fmt(clip.timeline_end - clip.timeline_start)}</small>}
                  </button>
                );
              })}
            </div>
          ))}
          {!plan && (
            <div className="timeline-empty">
              <span>AI timeline will appear here after analysis</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
