import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import Timeline from './components/Timeline';
import Inspector from './components/Inspector';
import PreviewStage from './components/PreviewStage';
import type { EditPlan, Health, JobStatus, Manifest, TimelineClip } from './types';

const starterPrompt = 'Make this feel intentional and polished. Remove dead space, keep the strongest visual beats, preserve important dialogue, use clean cuts, and do not add music unless I explicitly ask for it.';

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [activeJob, setActiveJob] = useState<JobStatus | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [selectedClip, setSelectedClip] = useState<TimelineClip | null>(null);
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
  const pollRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshJobs = async () => {
    try { setJobs((await api.jobs()).jobs); } catch { /* non-blocking */ }
  };

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    refreshJobs();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, []);

  const loadManifest = async (id: string, status?: JobStatus) => {
    const data = await api.manifest(id);
    setManifest(data);
    setPlan(data.plan);
    setActiveJob(status ?? data.status);
    setSelectedClip(null);
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
    if (localPreview) URL.revokeObjectURL(localPreview);
    setVideoFile(file);
    setLocalPreview(URL.createObjectURL(file));
    setActiveJob(null);
    setManifest(null);
    setPlan(null);
    setSelectedClip(null);
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
    try {
      await api.replan(activeJob.job_id, { edit_prompt: editPrompt.trim(), narration_text: narration.trim(), voice });
      poll(activeJob.job_id);
    } catch (error) {
      setBusy(false);
      setActiveJob({ ...activeJob, state: 'error', progress: 100, message: error instanceof Error ? error.message : 'AI revision failed' });
    }
  };

  const savePlan = async () => {
    if (!activeJob?.job_id || !plan) return;
    setSaving(true);
    try {
      const saved = await api.updatePlan(activeJob.job_id, plan);
      setPlan(saved);
      setSelectedClip(null);
    } finally {
      setSaving(false);
    }
  };

  const render = async () => {
    if (!activeJob?.job_id || !plan) return;
    setBusy(true);
    try {
      await api.render(activeJob.job_id, aspectRatio, captionStyle);
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
    setSelectedClip(null);
    setVideoFile(null);
    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(null);
    setEditPrompt(starterPrompt);
    setNarration('');
    setPanelTab('ai');
  };

  const previewSrc = useMemo(() => {
    if (activeJob?.job_id && activeJob.job_id !== 'error') {
      return activeJob.state === 'done'
        ? `${api.base}/api/jobs/${activeJob.job_id}/download?v=${Date.now()}`
        : `${api.base}/api/jobs/${activeJob.job_id}/source`;
    }
    return localPreview;
  }, [activeJob?.job_id, activeJob?.state, localPreview]);

  const quickPrompt = (text: string) => setEditPrompt((p) => `${p.trim()} ${text}`.trim());
  const state = activeJob?.state ?? 'idle';
  const canPlan = !!videoFile && !!editPrompt.trim() && !busy;
  const canRevise = !!plan && !!activeJob && !busy;
  const canRender = !!plan && !!activeJob && !busy && ['planned', 'done'].includes(activeJob.state);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-area">
          <button className="brand-mark" onClick={newProject}>CP</button>
          <div className="brand-copy"><b>CutPilot AI</b><span>AI video editor</span></div>
          <span className="top-divider" />
          <div className="project-name">
            <span className={`status-dot ${health?.ai_configured ? 'online' : ''}`} />
            <b>{manifest?.config?.source_name ? String(manifest.config.source_name) : videoFile?.name || 'Untitled project'}</b>
            <small>{activeJob ? `#${activeJob.job_id}` : 'Local draft'}</small>
          </div>
        </div>
        <div className="top-actions">
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
            <div className="assistant-card">
              <p>Describe the finished edit. I’ll use the actual scenes, transcript and frames to build the timeline.</p>
            </div>

            {plan?.summary && (
              <div className="assistant-card result">
                <span className="assistant-label">CURRENT PLAN</span>
                <p>{plan.summary}</p>
              </div>
            )}

            <div className="quick-actions">
              <button onClick={() => quickPrompt('Remove awkward pauses and dead space.')}>Remove dead space</button>
              <button onClick={() => quickPrompt('Make the pacing more tense and cinematic.')}>More cinematic</button>
              <button onClick={() => quickPrompt('Keep the edit fast and optimized for TikTok retention.')}>TikTok pacing</button>
              <button onClick={() => quickPrompt('Do not add music. Use only original audio, narration, and requested sound effects.')}>No music</button>
            </div>

            <label className="prompt-box">
              <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={8} placeholder="Tell CutPilot what to change…" />
              <div className="prompt-footer"><span>⌘ Enter</span><b>{editPrompt.length}</b></div>
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
            <button className="upload-card" onClick={() => fileInputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) chooseVideo(f); }}>
              <span>＋</span><b>Import video</b><small>Drop a file here or browse</small>
            </button>
            <input ref={fileInputRef} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && chooseVideo(e.target.files[0])} />

            <div className="section-title compact"><span>Project media</span><small>{videoFile || activeJob ? '1 asset' : '0 assets'}</small></div>
            {(videoFile || activeJob) ? (
              <div className="media-item">
                <div className="media-thumb">▶</div>
                <div><b>{videoFile?.name || String(manifest?.config?.source_name || 'Source video')}</b><small>Video · source</small></div>
              </div>
            ) : <div className="media-empty">Imported clips, sounds and generated media will live here.</div>}

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
          <div className="analysis-badges"><span>{manifest?.scenes?.length ?? 0} scenes</span><span>{manifest?.transcript?.length ?? 0} speech segments</span></div>
        </div>
        <PreviewStage src={previewSrc} aspectRatio={aspectRatio} state={state} />

        <div className={`job-banner ${state}`}>
          <div className="job-progress-ring" style={{ '--p': `${activeJob?.progress ?? 0}%` } as React.CSSProperties}><span>{activeJob?.progress ?? 0}</span></div>
          <div className="job-banner-copy"><b>{activeJob?.message || (videoFile ? 'Ready to analyze' : 'Start by importing a video')}</b><span>{activeJob?.summary || (health?.ai_configured ? 'AI editor online' : 'Add OPENAI_API_KEY to enable AI planning and voice')}</span></div>
          <div className="job-state-pill">{state}</div>
        </div>
      </main>

      <Inspector clip={selectedClip} plan={plan} onPlanChange={setPlan} onSave={savePlan} saving={saving} />

      <Timeline plan={plan} selectedClipId={selectedClip?.id ?? null} onSelectClip={setSelectedClip} />
    </div>
  );
}

export default App;
