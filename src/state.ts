import { loadProject, saveProject } from './db';
import { newId, type BgmSettings, type Clip, type ProjectData, type Telop } from './types';

export interface AppState {
  videoFile: Blob | null;
  videoName: string;
  videoUrl: string | null;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  clips: Clip[];
  telops: Telop[];
  selectedTelopId: string | null;
  videoVolume: number;
  bgm: BgmSettings | null;
  bgmFile: Blob | null;
}

export const state: AppState = {
  videoFile: null,
  videoName: '',
  videoUrl: null,
  videoDuration: 0,
  videoWidth: 0,
  videoHeight: 0,
  clips: [],
  telops: [],
  selectedTelopId: null,
  videoVolume: 1,
  bgm: null,
  bgmFile: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function onChange(fn: Listener): void {
  listeners.add(fn);
}

let saveTimer: number | undefined;

/** 変更を通知し、少し待ってから IndexedDB に保存する。 */
export function emitChange(persist = true): void {
  listeners.forEach((fn) => fn());
  if (!persist) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persistNow(), 500);
}

export async function persistNow(): Promise<void> {
  if (!state.videoFile) return;
  const data: ProjectData = {
    videoName: state.videoName,
    clips: state.clips,
    telops: state.telops,
    videoVolume: state.videoVolume,
    bgm: state.bgm,
    updatedAt: Date.now(),
  };
  try {
    await saveProject(data, state.videoFile, state.bgmFile);
  } catch (err) {
    console.warn('プロジェクトの保存に失敗しました', err);
  }
}

/** 端末内に残っている編集中プロジェクトを復元する。 */
export async function restoreProject(): Promise<boolean> {
  const stored = await loadProject();
  if (!stored || !stored.videoBlob) return false;
  state.videoFile = stored.videoBlob;
  state.videoName = stored.data.videoName;
  state.clips = stored.data.clips ?? [];
  state.telops = stored.data.telops ?? [];
  state.videoVolume = stored.data.videoVolume ?? 1;
  state.bgm = stored.data.bgm ?? null;
  state.bgmFile = stored.audioBlob ?? null;
  return true;
}

/* ---------- タイムライン計算 ---------- */

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.end - clip.start);
}

export function totalDuration(clips: Clip[] = state.clips): number {
  return clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** クリップ i がタイムライン上で始まる時刻。 */
export function clipTimelineStart(index: number, clips: Clip[] = state.clips): number {
  let t = 0;
  for (let i = 0; i < index && i < clips.length; i++) t += clipDuration(clips[i]);
  return t;
}

export interface TimelinePosition {
  clipIndex: number;
  sourceTime: number;
  localTime: number;
}

/** タイムライン秒 → 元動画の秒。 */
export function timelineToSource(
  time: number,
  clips: Clip[] = state.clips,
): TimelinePosition | null {
  if (clips.length === 0) return null;
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipDuration(clips[i]);
    if (time < acc + d || i === clips.length - 1) {
      const local = Math.min(Math.max(time - acc, 0), d);
      return { clipIndex: i, sourceTime: clips[i].start + local, localTime: local };
    }
    acc += d;
  }
  return null;
}

export function makeClip(start: number, end: number): Clip {
  return { id: newId('clip'), start, end };
}

export function resetForNewVideo(duration: number, width: number, height: number): void {
  state.videoDuration = duration;
  state.videoWidth = width;
  state.videoHeight = height;
  state.clips = [makeClip(0, duration)];
  state.telops = [];
  state.selectedTelopId = null;
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
