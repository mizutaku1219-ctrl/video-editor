import { decodeToAudioBuffer } from './audio-mix';
import { clipDuration, makeClip, sourceOfClip, state } from './state';
import type { Clip } from './types';

export interface SilenceOptions {
  /**
   * カットの強さ（0〜1）。
   * 静かなところ（環境音）と話し声の差のうち、どこを境目にするか。
   * 小さいほど控えめ（あまり切らない）、大きいほどよく切る。
   */
  strength: number;
  /** これより短い無音は消さない（秒）。 */
  minSilence: number;
  /** 前後に残す余白（秒）。切り口が不自然にならないようにする。 */
  padding: number;
}

export const DEFAULT_SILENCE: SilenceOptions = {
  strength: 0.35,
  minSilence: 0.45,
  padding: 0.12,
};

/** 解析結果の内訳（うまく切れないときの説明に使う）。 */
export interface LoudnessProfile {
  /** 環境音の大きさ（dBFS）。 */
  noiseFloorDb: number;
  /** 話し声などの大きさ（dBFS）。 */
  speechDb: number;
  /** 実際に使ったしきい値（dBFS）。 */
  thresholdDb: number;
  /** 環境音と話し声の差。小さいと切り分けできない。 */
  contrastDb: number;
}

let lastProfile: LoudnessProfile | null = null;
export function getLastProfile(): LoudnessProfile | null {
  return lastProfile;
}

function toDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-7));
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

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
  if (peak <= 0) {
    lastProfile = null;
    return [];
  }

  // 録音ごとに環境音の大きさが違うので、その動画自身の分布からしきい値を決める。
  // 下位20%＝ほぼ環境音、上位95%＝話し声、とみなしてその間に境目を置く。
  const sorted = Float32Array.from(rms).sort();
  const noiseFloor = percentile(sorted, 0.2);
  const speech = percentile(sorted, 0.95);
  const noiseFloorDb = toDb(noiseFloor);
  const speechDb = toDb(speech);
  const contrastDb = speechDb - noiseFloorDb;

  // 環境音と話し声の差が小さい動画（ずっと音が鳴っている等）は切りようがない
  if (contrastDb < 8) {
    lastProfile = { noiseFloorDb, speechDb, thresholdDb: noiseFloorDb, contrastDb };
    return [];
  }

  const strength = Math.min(0.9, Math.max(0.05, options.strength));
  const thresholdDb = noiseFloorDb + contrastDb * strength;
  const threshold = Math.pow(10, thresholdDb / 20);
  lastProfile = { noiseFloorDb, speechDb, thresholdDb, contrastDb };

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
