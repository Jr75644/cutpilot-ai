export type JobState = 'queued' | 'analyzing' | 'planning' | 'planned' | 'rendering' | 'done' | 'error';

export interface Health {
  ok: boolean;
  version: string;
  ai_configured: boolean;
  editor_model: string;
  transcribe_provider: string;
  workflow: string;
}

export interface JobStatus {
  job_id: string;
  state: JobState;
  progress: number;
  message: string;
  summary?: string;
  download_url?: string;
  plan_url?: string;
  manifest_url?: string;
  source_url?: string;
  timeline_duration?: number;
  created_at?: number;
  prompt?: string;
  aspect_ratio?: string;
}

export interface Segment {
  scene_id: number;
  start: number;
  end: number;
  reason: string;
}

export interface TimelineClip {
  id: string;
  kind: 'video' | 'text' | 'voiceover' | 'sfx';
  scene_id?: number;
  source_start?: number;
  source_end?: number;
  timeline_start: number;
  timeline_end: number;
  label: string;
  reason?: string;
  text?: string;
  position?: 'top' | 'center' | 'bottom';
}

export interface TimelineTrack {
  id: string;
  kind: 'video' | 'text' | 'voiceover' | 'sfx';
  label: string;
  clips: TimelineClip[];
}

export interface Timeline {
  duration: number;
  tracks: TimelineTrack[];
}

export interface EditPlan {
  version: number;
  summary: string;
  segments: Segment[];
  headline: string;
  voiceover: Array<{ at: number; text: string }>;
  text_overlays: Array<{ at: number; duration: number; text: string; position: string }>;
  overlay_audio_at: number | null;
  timeline: Timeline;
}

export interface Manifest {
  job_id: string;
  config: Record<string, unknown>;
  status: JobStatus;
  scenes: Array<{ id: number; start: number; end: number; duration: number }>;
  transcript: Array<{ start: number; end: number; text: string }>;
  frames: string[];
  plan: EditPlan | null;
}
