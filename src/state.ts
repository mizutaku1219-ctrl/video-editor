import { loadProject, saveProject } from './db';
import { newId, type BgmSettings, type Clip, type ProjectData, type Telop, type VideoSource } from './types';

export interface AppState {
  sources: VideoSource[];
  clips: Clip[];
  telops: Telop[];
  selectedTelopId: string | null;
  videoVolume: number;
  bgm: BgmSettings | null;
  bgmFile: Blob | null;
}

export const state: AppState = {
  sources: [],
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
  if (state.sources.length === 0) return;
  const data: ProjectData = {
    sources: state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      width: s.width,
      height: s.height,
    })),
    clips: state.clips,
    telops: state.telops,
    videoVolume: state.videoVolume,
    bgm: state.bgm,
    updatedAt: Date.now(),
  };
  const blobs: Record<string, Blob> = {};
  for (const s of state.sources) blobs[s.id] = s.blob;
  try {
    await saveProject(data, blobs, state.bgmFile);
  } catch (err) {
    console.warn('プロジェクトの保存に失敗しました', err);
  }
}

/** 端末内に残っている編集中プロジェクトを復元する。 */
export async function restoreProject(): Promise<boolean> {
  const stored = await loadProject();
  if (!stored) return false;
  const sources: VideoSource[] = [];
  for (const meta of stored.data.sources ?? []) {
    const blob = stored.videoBlobs[meta.id];
    if (blob) sources.push({ ...meta, blob });
  }
  if (sources.length === 0) return false;
  state.sources = sources;
  state.clips = (stored.data.clips ?? []).filter((c) => sources.some((s) => s.id === c.sourceId));
  state.telops = stored.data.telops ?? [];
  state.videoVolume = stored.data.videoVolume ?? 1;
  state.bgm = stored.data.bgm ?? null;
  state.bgmFile = stored.audioBlob ?? null;
  return state.clips.length > 0;
}

/* ---------- ソース ---------- */

export function findSource(id: string): VideoSource | null {
  return state.sources.find((s) => s.id === id) ?? null;
}

export function sourceOfClip(clip: Clip): VideoSource | null {
  return findSource(clip.sourceId);
}

/** 出力に使う解像度（読み込んだ動画のうち最大のもの）。 */
export function projectSize(): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const s of state.sources) {
    if (s.width * s.height > width * height) {
      width = s.width;
      height = s.height;
    }
  }
  return { width: width || 1280, height: height || 720 };
}

export function addSource(source: VideoSource): void {
  state.sources.push(source);
  state.clips.push(makeClip(source.id, 0, source.duration));
}

export function removeSource(id: string): void {
  state.sources = state.sources.filter((s) => s.id !== id);
  state.clips = state.clips.filter((c) => c.sourceId !== id);
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

/** タイムライン秒 → そのクリップの元動画の秒。 */
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

export function makeClip(sourceId: string, start: number, end: number): Clip {
  return { id: newId('clip'), sourceId, start, end };
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
