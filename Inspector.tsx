import { clonePlan, normalizePlan } from '../editor';
import type { EditPlan, TimelineClip } from '../types';

interface Props {
  clip: TimelineClip | null;
  plan: EditPlan | null;
  onPlanChange: (next: EditPlan) => void;
  onCheckpoint: () => void;
  onSave: () => void;
  saving: boolean;
  saveState: 'saved' | 'unsaved' | 'saving' | 'error';
}

export default function Inspector({ clip, plan, onPlanChange, onCheckpoint, onSave, saving, saveState }: Props) {
  const updateClip = (patch: Partial<TimelineClip>) => {
    if (!plan || !clip) return;
    const next = clonePlan(plan);
    for (const track of next.timeline.tracks) {
      const index = track.clips.findIndex((item) => item.id === clip.id);
      if (index >= 0) {
        track.clips[index] = { ...track.clips[index], ...patch };
        break;
      }
    }
    onPlanChange(normalizePlan(next));
  };

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
        <div className="section-title"><span>Inspector</span><small className={`save-indicator ${saveState}`}>{saveState}</small></div>
        <label className="field"><span>Headline</span><input value={plan.headline} onFocus={onCheckpoint} onChange={(e) => onPlanChange({ ...plan, headline: e.target.value })} /></label>
        <label className="field"><span>AI summary</span><textarea rows={7} value={plan.summary} onFocus={onCheckpoint} onChange={(e) => onPlanChange({ ...plan, summary: e.target.value })} /></label>
        <button className="secondary full" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save now'}</button>
      </aside>
    );
  }

  const isVideo = clip.kind === 'video';
  const clipDuration = clip.timeline_end - clip.timeline_start;

  return (
    <aside className="inspector panel-surface">
      <div className="section-title"><span>Inspector</span><small className={`save-indicator ${saveState}`}>{saveState}</small></div>
      <div className="clip-type-card">
        <span className={`clip-type-icon ${clip.kind}`}>{clip.kind === 'video' ? '▶' : clip.kind === 'voiceover' ? '◖' : clip.kind === 'text' ? 'T' : '♪'}</span>
        <div><b>{clip.label}</b><small>{clip.kind}</small></div>
      </div>

      {isVideo && (
        <>
          <div className="field-grid">
            <label className="field"><span>Source in</span><input type="number" step="0.01" value={(clip.source_start ?? 0).toFixed(2)} onFocus={onCheckpoint} onChange={(e) => updateClip({ source_start: Number(e.target.value) })} /></label>
            <label className="field"><span>Source out</span><input type="number" step="0.01" value={(clip.source_end ?? 0).toFixed(2)} onFocus={onCheckpoint} onChange={(e) => updateClip({ source_end: Number(e.target.value) })} /></label>
          </div>
          <label className="field"><span>Why AI kept this</span><textarea rows={5} value={clip.reason ?? ''} onFocus={onCheckpoint} onChange={(e) => updateClip({ reason: e.target.value })} /></label>
          <div className="info-row"><span>Scene</span><b>#{(clip.scene_id ?? 0) + 1}</b></div>
          <div className="info-row"><span>Timeline in</span><b>{clip.timeline_start.toFixed(2)}s</b></div>
          <div className="info-row"><span>Clip duration</span><b>{clipDuration.toFixed(2)}s</b></div>
        </>
      )}

      {!isVideo && (
        <>
          <label className="field"><span>Timeline start</span><input type="number" min="0" step="0.05" value={clip.timeline_start.toFixed(2)} onFocus={onCheckpoint} onChange={(e) => {
            const start = Math.max(0, Number(e.target.value));
            updateClip({ timeline_start: start, timeline_end: start + clipDuration });
          }} /></label>
          {(clip.kind === 'text' || clip.kind === 'voiceover') && (
            <label className="field"><span>{clip.kind === 'text' ? 'On-screen text' : 'Narration text'}</span><textarea rows={5} value={clip.text ?? ''} onFocus={onCheckpoint} onChange={(e) => updateClip({ text: e.target.value, label: e.target.value.slice(0, 30) || clip.label })} /></label>
          )}
          {clip.kind === 'text' && (
            <label className="field"><span>Position</span><select value={clip.position ?? 'center'} onFocus={onCheckpoint} onChange={(e) => updateClip({ position: e.target.value as TimelineClip['position'] })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>
          )}
          <div className="info-row"><span>Duration</span><b>{clipDuration.toFixed(2)}s</b></div>
        </>
      )}

      <button className="secondary full" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save now'}</button>
    </aside>
  );
}
