import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from './api';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
import PreviewStage from './components/PreviewStage';
import { clipById, deleteClip, getTrack, splitVideoClip } from './editor';
import type { EditPlan, Health, JobStatus, Manifest, TimelineClip } from './types';

const starterPrompt = 'Make this feel intentional and polished. Remove dead space, keep the strongest visual beats, preserve important dialogue, use clean cuts, and do not add music unless I explicitly ask for it.';

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panelTab, setPanelTab] = useState<'ai' | 'media'>('ai');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [sfxFile, setSfxFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState(starterPrompt);
  const [narration, setNarration] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [captionStyle, setCaptionStyle] = useState('social');
  const [burnCaptions, setBurnCaptions] = useState(true);
  const [keepAudio, setKeepAudio] = useState(true);
  const [sfxTime, setSfxTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved');
  const [historyTick, setHistoryTick] = useState(0);

  const pollRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSavedRef = useRef('');
  const undoRef = useRef<EditPlan[]>([]);
  const redoRef = useRef<EditPlan[]>([]);

  const selectedClip = useMemo(() => clipById(plan, selectedClipId), [plan, selectedClipId]);
  const canUndo = historyTick >= 0 && undoRef.current.length > 0;
  const canRedo = historyTick >= 0 && redoRef.current.length > 0;

  const refreshJobs = async () => {
    try { setJobs((await api.jobs()).jobs); } catch { /* non-blocking */ }
  };

  const resetHistory = () => {
    undoRef.current = [];
    redoRef.current = [];
    setHistoryTick((value) => value + 1);
  };

  const checkpoint = () => {
    if (!plan) return;
    const snapshot = structuredClone(plan);
    const top = undoRef.current[undoRef.current.length - 1];
    if (!top || JSON.stringify(top) !== JSON.stringify(snapshot)) {
      undoRef.current.push(snapshot);
      if (undoRef.current.length > 50) undoRef.current.shift();
    }
    redoRef.current = [];
    setHistoryTick((value) => value + 1);
  };

  const changePlan = (next: EditPlan) => {
    setPlan(next);
    if (activeJob && activeJob.job_id !== 'error') setSaveState('unsaved');
  };

  const undo = () => {
    if (!plan || !undoRef.current.length) return;
    const previous = undoRef.current.pop()!;
    redoRef.current.push(structuredClone(plan));
    setPlan(previous);
    setSaveState('unsaved');
    setHistoryTick((value) => value + 1);
  };

  const redo = () => {
    if (!plan || !redoRef.current.length) return;
    const next = redoRef.current.pop()!;
    undoRef.current.push(structuredClone(plan));
    setPlan(next);
    setSaveState('unsaved');
    setHistoryTick((value) => value + 1);
  };

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    refreshJobs();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => () => {
    if (localPreview) URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const loadManifest = async (id: string, status?: JobStatus) => {
    const data = await api.manifest(id);
    setManifest(data);
    setPlan(data.plan);
    setActiveJob(status ?? data.status);
    setSelectedClipId(null);
    setPlayhead(0);
    setPlaying(false);
    lastSavedRef.current = data.plan ? JSON.stringify(data.plan) : '';
    setSaveState('saved');
    resetHistory();
    const cfg = data.config;
    if (typeof cfg.edit_prompt === 'string') setEditPrompt(cfg.edit_prompt);
    if (typeof cfg.narration_text === 'string') setNarration(cfg.narration_text);
    if (typeof cfg.voice === 'string') setVoice(cfg.voice);
    if (typeof cfg.aspect_ratio === 'string') setAspectRatio(cfg.aspect_ratio);
    if (typeof cfg.caption_style === 'string') setCaptionStyle(cfg.caption_style);
    if (typeof cfg.burn_captions === 'boolean') setBurnCaptions(cfg.burn_captions);
    if (typeof cfg.keep_original_audio === 'boolean') setKeepAudio(cfg.keep_original_audio);
  };

  const poll = async (id: string) => {
    try {
      const status = await api.job(id);
      setActiveJob(status);
      if (status.state === 'planned' || status.state === 'done') {
        await loadManifest(id, status);
        setBusy(false);
        refreshJobs();
        return;
      }
      if (status.state === 'error') {
        setBusy(false);
        refreshJobs();
        return;
      }
      pollRef.current = window.setTimeout(() => poll(id), 900);
    } catch {
      setBusy(false);
    }
  };

  const chooseVideo = (file: File) => {
    if (!file.type.startsWith('video/')) return;
    setVideoFile(file);
    setLocalPreview(URL.createObjectURL(file));
    setActiveJob(null);
    setManifest(null);
    setPlan(null);
    setSelectedClipId(null);
    setPlayhead(0);
    setPlaying(false);
    resetHistory();
  };

  const startJob = async () => {
    if (!videoFile || !editPrompt.trim()) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('video', videoFile);
    fd.append('edit_prompt', editPrompt.trim());
    fd.append('narration_text', narration.trim());
    fd.append('voice', voice);
    fd.append('burn_captions', burnCaptions ? 'true' : 'false');
    fd.append('keep_original_audio', keepAudio ? 'true' : 'false');
    fd.append('aspect_ratio', aspectRatio);
    fd.append('caption_style', captionStyle);
    if (sfxFile) fd.append('overlay_audio', sfxFile);
    if (sfxTime.trim()) fd.append('overlay_audio_at', sfxTime.trim());
    try {
      const created = await api.createJob(fd);
      setActiveJob({ job_id: created.job_id, state: 'queued', progress: 3, message: 'Upload complete' });
      poll(created.job_id);
    } catch (error) {
      setActiveJob({ job_id: 'error', state: 'error', progress: 100, message: error instanceof Error ? error.message : 'Upload failed' });
      setBusy(false);
    }
  };

  const reviseWithAI = async () => {
    if (!activeJob?.job_id || activeJob.job_id === 'error' || !editPrompt.trim()) return;
    setBusy(true);
    setPlaying(false);
    try {
      await api.replan(activeJob.job_id, { edit_prompt: editPrompt.trim(), narration_text: narration.trim(), voice });
      poll(activeJob.job_id);
    } catch (error) {
      setBusy(false);
      setActiveJob({ ...activeJob, state: 'error', progress: 100, message: error instanceof Error ? error.message : 'AI revision failed' });
    }
  };

  const persistPlan = async (): Promise<EditPlan | null> => {
    if (!activeJob?.job_id || activeJob.job_id === 'error' || !plan) return plan;
    const serialized = JSON.stringify(plan);
    if (serialized === lastSavedRef.current) return plan;
    setSaving(true);
    setSaveState('saving');
    try {
      const saved = await api.updatePlan(activeJob.job_id, plan);
      lastSavedRef.current = JSON.stringify(saved);
      setPlan(saved);
      setActiveJob((current) => current ? { ...current, state: 'planned', message: 'Timeline saved', progress: 100 } : current);
      setSaveState('saved');
      return saved;
    } catch {
      setSaveState('error');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const savePlan = async () => { await persistPlan(); };

  useEffect(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (!plan || !activeJob || activeJob.job_id === 'error' || busy) return;
    if (!['planned', 'done'].includes(activeJob.state)) return;
    const serialized = JSON.stringify(plan);
    if (serialized === lastSavedRef.current) {
      setSaveState('saved');
      return;
    }
    setSaveState('unsaved');
    saveTimerRef.current = window.setTimeout(() => { void persistPlan(); }, 900);
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); };
  }, [plan, activeJob?.job_id, activeJob?.state, busy]);

  const render = async () => {
    if (!activeJob?.job_id || !plan) return;
    setBusy(true);
    setPlaying(false);
    try {
      const saved = await persistPlan();
      if (!saved) throw new Error('Timeline could not be saved');
      await api.render(activeJob.job_id, aspectRatio, captionStyle, burnCaptions, keepAudio, voice);
      poll(activeJob.job_id);
    } catch (error) {
      setBusy(false);
      setActiveJob({ ...activeJob, state: 'error', progress: 100, message: error instanceof Error ? error.message : 'Render failed' });
    }
  };

  const openJob = async (job: JobStatus) => {
    setBusy(job.state !== 'planned' && job.state !== 'done' && job.state !== 'error');
    await loadManifest(job.job_id, job);
    if (job.state !== 'planned' && job.state !== 'done' && job.state !== 'error') poll(job.job_id);
  };

  const newProject = () => {
    setActiveJob(null);
    setManifest(null);
    setPlan(null);
    setSelectedClipId(null);
    setVideoFile(null);
    setLocalPreview(null);
    setEditPrompt(starterPrompt);
    setNarration('');
    setPlayhead(0);
    setPlaying(false);
    setPanelTab('ai');
    resetHistory();
  };

  const splitSelected = () => {
    if (!plan) return;
    const video = getTrack(plan, 'video');
    const target = video?.clips.find((clip) => clip.id === selectedClipId && playhead > clip.timeline_start && playhead < clip.timeline_end)
      ?? video?.clips.find((clip) => playhead > clip.timeline_start && playhead < clip.timeline_end);
    if (!target) return;
    checkpoint();
    const result = splitVideoClip(plan, target.id, playhead);
    changePlan(result.plan);
    setSelectedClipId(result.selectedId);
  };

  const deleteSelected = () => {
    if (!plan || !selectedClipId) return;
    checkpoint();
    changePlan(deleteClip(plan, selectedClipId));
    setSelectedClipId(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void savePlan();
      } else if (event.code === 'Space') {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      } else if (event.key.toLowerCase() === 's') {
        splitSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plan, selectedClipId, playhead]);

  const previewSrc = useMemo(() => {
    if (activeJob?.job_id && activeJob.job_id !== 'error') {
      return activeJob.state === 'done'
        ? `${api.base}/api/jobs/${activeJob.job_id}/download`
        : `${api.base}/api/jobs/${activeJob.job_id}/source`;
    }
    return localPreview;
  }, [activeJob?.job_id, activeJob?.state, localPreview]);

  const quickPrompt = (text: string) => setEditPrompt((value) => `${value.trim()} ${text}`.trim());
  const state = activeJob?.state ?? 'idle';
  const canPlan = !!videoFile && !!editPrompt.trim() && !busy;
  const canRevise = !!plan && !!activeJob && !busy;
  const canRender = !!plan && !!activeJob && !busy && ['planned', 'done'].includes(activeJob.state);

  const selectTimelineClip = (clip: TimelineClip) => {
    setSelectedClipId(clip.id);
    setPlayhead(clip.timeline_start);
    setPlaying(false);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-area">
          <button className="brand-mark" onClick={newProject}>CP</button>
          <div className="brand-copy"><b>CutPilot AI</b><span>AI video editor · v0.3</span></div>
          <span className="top-divider" />
          <div className="project-name">
            <span className={`status-dot ${health?.ai_configured ? 'online' : ''}`} />
            <b>{manifest?.config?.source_name ? String(manifest.config.source_name) : videoFile?.name || 'Untitled project'}</b>
            <small>{activeJob ? `#${activeJob.job_id}` : 'Local draft'}</small>
          </div>
        </div>
        <div className="top-actions">
          <span className={`top-save-state ${saveState}`}>{saveState === 'saved' ? '✓ Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save error' : 'Unsaved'}</span>
          <button className="ghost" onClick={undo} disabled={!canUndo}>↶</button>
          <button className="ghost" onClick={redo} disabled={!canRedo}>↷</button>
          <button className="ghost" onClick={savePlan} disabled={!plan || saving}>Save</button>
          {activeJob?.state === 'done' && <a className="ghost link-button" href={`${api.base}/api/jobs/${activeJob.job_id}/download`}>Download</a>}
          <button className="render-button" onClick={render} disabled={!canRender}><span>◆</span>{busy && state === 'rendering' ? 'Rendering…' : 'Render video'}</button>
        </div>
      </header>

      <aside className="icon-rail">
        <button className="rail-logo active">✦</button>
        <button title="Projects" onClick={() => setPanelTab('media')}>▦</button>
        <button title="AI editor" onClick={() => setPanelTab('ai')}>⌁</button>
        <button title="Captions">T</button>
        <button title="Audio">♫</button>
        <span className="rail-grow" />
        <button title="Settings">⚙</button>
      </aside>

      <aside className="left-panel panel-surface">
        <div className="left-tabs">
          <button className={panelTab === 'ai' ? 'active' : ''} onClick={() => setPanelTab('ai')}>AI Editor</button>
          <button className={panelTab === 'media' ? 'active' : ''} onClick={() => setPanelTab('media')}>Media</button>
        </div>

        {panelTab === 'ai' ? (
          <div className="ai-panel-scroll">
            <div className="ai-intro">
              <div className="ai-avatar">✦</div>
              <div><b>CutPilot</b><span>{health?.ai_configured ? `Ready · ${health.editor_model}` : 'AI key not configured'}</span></div>
            </div>
            <div className="assistant-card"><p>Describe the finished edit. I’ll use the actual scenes, transcript and frames to build the timeline.</p></div>
            {plan?.summary && <div className="assistant-card result"><span className="assistant-label">CURRENT PLAN</span><p>{plan.summary}</p></div>}
            <div className="quick-actions">
              <button onClick={() => quickPrompt('Remove awkward pauses and dead space.')}>Remove dead space</button>
              <button onClick={() => quickPrompt('Make the pacing more tense and cinematic.')}>More cinematic</button>
              <button onClick={() => quickPrompt('Keep the edit fast and optimized for TikTok retention.')}>TikTok pacing</button>
              <button onClick={() => quickPrompt('Do not add music. Use only original audio, narration, and requested sound effects.')}>No music</button>
            </div>
            <label className="prompt-box">
              <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={8} placeholder="Tell CutPilot what to change…" />
              <div className="prompt-footer"><span>AI edits the current timeline</span><b>{editPrompt.length}</b></div>
            </label>
            <label className="field"><span>Narration <i>optional</i></span><textarea rows={4} value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Exact words for the AI voice to say…" /></label>
            <div className="field-grid">
              <label className="field"><span>Voice</span><select value={voice} onChange={(e) => setVoice(e.target.value)}><option>alloy</option><option>ash</option><option>coral</option><option>echo</option><option>fable</option><option>nova</option><option>onyx</option><option>sage</option><option>shimmer</option></select></label>
              <label className="field"><span>Format</span><select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}><option value="9:16">9:16 Vertical</option><option value="16:9">16:9 Wide</option><option value="1:1">1:1 Square</option><option value="4:5">4:5 Social</option><option value="original">Original</option></select></label>
            </div>
            <label className="field"><span>Caption style</span><select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)}><option value="social">Bold social</option><option value="clean">Clean</option><option value="minimal">Minimal</option></select></label>
            <div className="toggle-row"><span><b>Auto captions</b><small>Burn speech into export</small></span><input type="checkbox" checked={burnCaptions} onChange={(e) => setBurnCaptions(e.target.checked)} /></div>
            <div className="toggle-row"><span><b>Original audio</b><small>Keep source audio under voice</small></span><input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} /></div>
            {!plan ? (
              <button className="ai-action" onClick={startJob} disabled={!canPlan}><span>✦</span>{busy ? 'Analyzing video…' : 'Analyze & build timeline'}</button>
            ) : (
              <button className="ai-action" onClick={reviseWithAI} disabled={!canRevise}><span>✦</span>{busy && state === 'planning' ? 'Rebuilding timeline…' : 'Apply prompt to timeline'}</button>
            )}
          </div>
        ) : (
          <div className="media-panel-scroll">
            <button className="upload-card" onClick={() => fileInputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) chooseVideo(file); }}>
              <span>＋</span><b>Import video</b><small>Drop a file here or browse</small>
            </button>
            <input ref={fileInputRef} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && chooseVideo(e.target.files[0])} />
            <div className="section-title compact"><span>Project media</span><small>{videoFile || activeJob ? '1 asset' : '0 assets'}</small></div>
            {(videoFile || activeJob) ? <div className="media-item"><div className="media-thumb">▶</div><div><b>{videoFile?.name || String(manifest?.config?.source_name || 'Source video')}</b><small>Video · source</small></div></div> : <div className="media-empty">Imported clips, sounds and generated media will live here.</div>}
            <label className="field"><span>Sound effect <i>optional</i></span><input type="file" accept="audio/*" onChange={(e) => setSfxFile(e.target.files?.[0] || null)} /></label>
            <label className="field"><span>SFX timeline time <i>optional</i></span><input type="number" min="0" step="0.1" value={sfxTime} onChange={(e) => setSfxTime(e.target.value)} placeholder="AI decides when blank" /></label>
            <div className="section-title compact"><span>Recent projects</span><button onClick={refreshJobs}>↻</button></div>
            <div className="recent-jobs">
              {jobs.map((job) => <button key={job.job_id} className={activeJob?.job_id === job.job_id ? 'active' : ''} onClick={() => openJob(job)}><span className={`job-dot ${job.state}`} /><div><b>{job.prompt?.slice(0, 42) || `Project ${job.job_id}`}</b><small>{job.state} · {job.progress}%</small></div></button>)}
              {!jobs.length && <div className="media-empty">No saved jobs yet.</div>}
            </div>
          </div>
        )}
      </aside>

      <main className="editor-center">
        <div className="center-topline">
          <div className="breadcrumbs"><b>Editor</b><span>/</span><span>{aspectRatio}</span></div>
          <div className="analysis-badges"><span>{manifest?.scenes?.length ?? 0} scenes</span><span>{manifest?.transcript?.length ?? 0} speech segments</span><span>Space: play</span><span>S: split</span></div>
        </div>
        <PreviewStage
          src={previewSrc}
          aspectRatio={aspectRatio}
          state={state}
          plan={plan}
          playhead={playhead}
          playing={playing}
          rendered={state === 'done'}
          onPlayheadChange={setPlayhead}
          onPlayingChange={setPlaying}
        />
        <div className={`job-banner ${state}`}>
          <div className="job-progress-ring" style={{ '--p': `${activeJob?.progress ?? 0}%` } as CSSProperties}><span>{activeJob?.progress ?? 0}</span></div>
          <div className="job-banner-copy"><b>{activeJob?.message || (videoFile ? 'Ready to analyze' : 'Start by importing a video')}</b><span>{activeJob?.summary || (health?.ai_configured ? 'AI editor online' : 'Add OPENAI_API_KEY to enable AI planning and voice')}</span></div>
          <div className="job-state-pill">{state}</div>
        </div>
      </main>

      <Inspector clip={selectedClip} plan={plan} onPlanChange={changePlan} onCheckpoint={checkpoint} onSave={savePlan} saving={saving} saveState={saveState} />

      <Timeline
        plan={plan}
        selectedClipId={selectedClipId}
        scenes={manifest?.scenes ?? []}
        playhead={playhead}
        zoom={zoom}
        canUndo={canUndo}
        canRedo={canRedo}
        onSelectClip={selectTimelineClip}
        onPlanChange={changePlan}
        onCheckpoint={checkpoint}
        onPlayheadChange={setPlayhead}
        onPlayingChange={setPlaying}
        onZoomChange={setZoom}
        onUndo={undo}
        onRedo={redo}
        onSplit={splitSelected}
        onDelete={deleteSelected}
      />
    </div>
  );
}

export default App;
