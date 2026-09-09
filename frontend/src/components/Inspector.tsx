import type { EditPlan, TimelineClip } from '../types';

interface Props {
  clip: TimelineClip | null;
  plan: EditPlan | null;
  onPlanChange: (next: EditPlan) => void;
  onSave: () => void;
  saving: boolean;
}

export default function Inspector({ clip, plan, onPlanChange, onSave, saving }: Props) {
  if (!plan) {
    return (
      <aside className="inspector panel-surface">
        <div className="section-title"><span>Inspector</span><small>No selection</small></div>
        <div className="empty-inspector">
          <div className="empty-orb">◇</div>
          <b>Select a timeline clip</b>
          <p>Clip timing, text, audio and AI reasoning will show here.</p>
        </div>
      </aside>
    );
  }

  if (!clip) {
    return (
      <aside className="inspector panel-surface">
        <div className="section-title"><span>Inspector</span><small>Project</small></div>
        <label className="field"><span>Headline</span><input value={plan.headline} onChange={(e) => onPlanChange({ ...plan, headline: e.target.value })} /></label>
        <label className="field"><span>AI summary</span><textarea rows={7} value={plan.summary} onChange={(e) => onPlanChange({ ...plan, summary: e.target.value })} /></label>
        <button className="secondary full" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save timeline'}</button>
      </aside>
    );
  }

  const isVideo = clip.kind === 'video';
  const segmentIndex = isVideo ? plan.timeline.tracks.find(t => t.kind === 'video')?.clips.findIndex(c => c.id === clip.id) ?? -1 : -1;
  const segment = segmentIndex >= 0 ? plan.segments[segmentIndex] : null;

  const updateSegment = (patch: Partial<{ start: number; end: number; reason: string }>) => {
    if (!segment || segmentIndex < 0) return;
    const segments = [...plan.segments];
    segments[segmentIndex] = { ...segment, ...patch };
    onPlanChange({ ...plan, segments });
  };

  return (
    <aside className="inspector panel-surface">
      <div className="section-title"><span>Inspector</span><small>{clip.label}</small></div>
      <div className="clip-type-card">
        <span className={`clip-type-icon ${clip.kind}`}>{clip.kind === 'video' ? '▶' : clip.kind === 'voiceover' ? '◖' : clip.kind === 'text' ? 'T' : '♪'}</span>
        <div><b>{clip.label}</b><small>{clip.kind}</small></div>
      </div>

      {isVideo && segment && (
        <>
          <div className="field-grid">
            <label className="field"><span>Source in</span><input type="number" step="0.01" value={segment.start} onChange={(e) => updateSegment({ start: Number(e.target.value) })} /></label>
            <label className="field"><span>Source out</span><input type="number" step="0.01" value={segment.end} onChange={(e) => updateSegment({ end: Number(e.target.value) })} /></label>
          </div>
          <label className="field"><span>Why AI kept this</span><textarea rows={5} value={segment.reason} onChange={(e) => updateSegment({ reason: e.target.value })} /></label>
          <div className="info-row"><span>Scene</span><b>#{segment.scene_id + 1}</b></div>
          <div className="info-row"><span>Clip duration</span><b>{Math.max(0, segment.end - segment.start).toFixed(2)}s</b></div>
        </>
      )}

      {!isVideo && (
        <div className="inspector-copy">
          <span>Timeline start</span><b>{clip.timeline_start.toFixed(2)}s</b>
          {clip.text && <p>{clip.text}</p>}
        </div>
      )}

      <button className="secondary full" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save timeline changes'}</button>
    </aside>
  );
}
