import { decodeToAudioBuffer } from './audio-mix';
import { clipDuration, makeClip, sourceOfClip, state } from './state';
import type { Clip } from './types';

export interface SilenceOptions {
  /** 無音と判断する音量のしきい値（dB、-60〜-20 くらい）。 */
  thresholdDb: number;
  /** これより短い無音は消さない（秒）。 */
  minSilence: number;
  /** 前後に残す余白（秒）。切り口が不自然にならないようにする。 */
  padding: number;
}

export const DEFAULT_SILENCE: SilenceOptions = {
  thresholdDb: -38,
  minSilence: 0.45,
  padding: 0.12,
};

/** 音のある区間（秒）を求める。 */
export function detectLoudRanges(
  buffer: AudioBuffer,
  options: SilenceOptions,
): { start: number; end: number }[] {
  const windowSec = 0.02;
  const rate = buffer.sampleRate;
  const windowSize = Math.max(1, Math.round(windowSec * rate));
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));

  const windowCount = Math.ceil(length / windowSize);
  const rms = new Float32Array(windowCount);
  let peak = 0;
  for (let w = 0; w < windowCount; w++) {
    const from = w * windowSize;
    const to = Math.min(length, from + windowSize);
    let sum = 0;
    let n = 0;
    for (let i = from; i < to; i += 2) {
      for (let ch = 0; ch < channels; ch++) {
        const v = data[ch][i];
        sum += v * v;
        n++;
      }
    }
    const value = n > 0 ? Math.sqrt(sum / n) : 0;
    rms[w] = value;
    if (value > peak) peak = value;
  }
  if (peak <= 0) return [];

  // しきい値はピーク基準の相対値。小さい声でも取りこぼしにくい。
  const threshold = peak * Math.pow(10, options.thresholdDb / 20);
  const loud: boolean[] = [];
  for (let w = 0; w < windowCount; w++) loud.push(rms[w] >= threshold);

  // 短い無音は「音あり」とみなして埋める
  const minSilenceWindows = Math.max(1, Math.round(options.minSilence / windowSec));
  let runStart = -1;
  for (let w = 0; w <= windowCount; w++) {
    const isSilent = w < windowCount && !loud[w];
    if (isSilent && runStart < 0) runStart = w;
    if (!isSilent && runStart >= 0) {
      if (w - runStart < minSilenceWindows) for (let i = runStart; i < w; i++) loud[i] = true;
      runStart = -1;
    }
  }

  const ranges: { start: number; end: number }[] = [];
  let from = -1;
  for (let w = 0; w <= windowCount; w++) {
    const isLoud = w < windowCount && loud[w];
    if (isLoud && from < 0) from = w;
    if (!isLoud && from >= 0) {
      ranges.push({
        start: Math.max(0, from * windowSec - options.padding),
        end: Math.min(buffer.duration, w * windowSec + options.padding),
      });
      from = -1;
    }
  }

  // 余白でくっついた区間をつなげる
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.01) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= 0.2);
}

export interface SilenceResult {
  clips: Clip[];
  removedSeconds: number;
}

/**
 * 今のクリップ構成に無音カットを適用した新しいクリップ列を返す。
 * 音を読み取れない動画のクリップはそのまま残す。
 */
export async function buildSilenceCutClips(
  options: SilenceOptions,
  onProgress?: (ratio: number, label: string) => void,
): Promise<SilenceResult> {
  const next: Clip[] = [];
  let removed = 0;
  const rangeCache = new Map<string, { start: number; end: number }[] | null>();

  for (const clip of state.clips) {
    const source = sourceOfClip(clip);
    if (!source) {
      next.push(clip);
      continue;
    }
    let ranges = rangeCache.get(source.id);
    if (ranges === undefined) {
      const buffer = await decodeToAudioBuffer(source.blob, { allowRealtime: true, onProgress });
      ranges = buffer ? detectLoudRanges(buffer, options) : null;
      rangeCache.set(source.id, ranges);
    }
    if (!ranges || ranges.length === 0) {
      next.push(clip);
      continue;
    }
    const kept: Clip[] = [];
    for (const r of ranges) {
      const start = Math.max(clip.start, r.start);
      const end = Math.min(clip.end, r.end);
      if (end - start >= 0.2) kept.push(makeClip(source.id, start, end));
    }
    if (kept.length === 0) {
      // 全部無音なら、短くして1つだけ残す（完全に消えてしまうのを防ぐ）
      next.push(makeClip(source.id, clip.start, Math.min(clip.end, clip.start + 1)));
      removed += Math.max(0, clipDuration(clip) - 1);
      continue;
    }
    removed += clipDuration(clip) - kept.reduce((s, c) => s + clipDuration(c), 0);
    next.push(...kept);
  }

  return { clips: next, removedSeconds: Math.max(0, removed) };
}
