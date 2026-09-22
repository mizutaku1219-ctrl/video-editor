import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { getAudioContext } from './audio-ctx';

/**
 * 動画・音声ファイルから AudioBuffer を取り出す。
 * ブラウザによって使える手段が違うため、次の順で試す。
 *   1. decodeAudioData（48kHz） … Chrome / Edge で速い
 *   2. decodeAudioData（44.1kHz）… Safari はこちらなら通ることがある
 *   3. WebCodecs + Mediabunny    … 動画コンテナの音声に強い
 *   4. 実時間での再生取り込み      … 最後の手段。動画の長さぶん時間がかかる
 */

const cache = new Map<Blob, AudioBuffer | null>();
let lastReasons: string[] = [];

/** 直近のデコードで失敗した理由（デバッグ・画面表示用）。 */
export function getDecodeReasons(): string[] {
  return lastReasons;
}

export interface DecodeOptions {
  /** 実時間での取り込みを許可するか（時間がかかるので既定はfalse）。 */
  allowRealtime?: boolean;
  onProgress?: (ratio: number, label: string) => void;
}

export async function decodeAudio(blob: Blob, options: DecodeOptions = {}): Promise<AudioBuffer | null> {
  const cached = cache.get(blob);
  if (cached !== undefined && cached !== null) return cached;

  const reasons: string[] = [];

  for (const rate of [48000, 44100]) {
    try {
      const ctx = new OfflineAudioContext(2, Math.round(rate * 0.1), rate);
      const buf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      if (decoded && decoded.length > 0) {
        cache.set(blob, decoded);
        lastReasons = reasons;
        return decoded;
      }
      reasons.push(`decodeAudioData(${rate}): 空のデータ`);
    } catch (err) {
      reasons.push(`decodeAudioData(${rate}): ${errText(err)}`);
    }
  }

  try {
    const decoded = await decodeWithWebCodecs(blob);
    if (decoded) {
      cache.set(blob, decoded);
      lastReasons = reasons;
      return decoded;
    }
    reasons.push('WebCodecs: 音声トラックが見つかりませんでした');
  } catch (err) {
    reasons.push(`WebCodecs: ${errText(err)}`);
  }

  if (options.allowRealtime) {
    try {
      options.onProgress?.(0, '音声を取り込んでいます…（動画の長さぶん時間がかかります）');
      const decoded = await captureByPlayback(blob, options.onProgress);
      if (decoded) {
        cache.set(blob, decoded);
        lastReasons = reasons;
        return decoded;
      }
      reasons.push('再生取り込み: 音が入っていませんでした');
    } catch (err) {
      reasons.push(`再生取り込み: ${errText(err)}`);
    }
  }

  lastReasons = reasons;
  cache.set(blob, null);
  return null;
}

/** キャッシュを捨てる（設定を変えて試し直すとき用）。 */
export function forgetAudio(blob: Blob): void {
  cache.delete(blob);
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function decodeWithWebCodecs(blob: Blob): Promise<AudioBuffer | null> {
  if (typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder !== 'function') {
    throw new Error('この環境は AudioDecoder に対応していません');
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const sink = new AudioBufferSink(track);
    const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
    let channels = 0;
    let rate = 48000;
    let end = 0;
    for await (const wrapped of sink.buffers()) {
      chunks.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp });
      channels = Math.max(channels, wrapped.buffer.numberOfChannels);
      rate = wrapped.buffer.sampleRate;
      end = Math.max(end, wrapped.timestamp + wrapped.duration);
    }
    if (chunks.length === 0) return null;
    const out = new AudioBuffer({
      numberOfChannels: Math.max(1, channels),
      length: Math.max(1, Math.ceil(end * rate)),
      sampleRate: rate,
    });
    for (const { buffer, timestamp } of chunks) {
      const offset = Math.round(timestamp * rate);
      for (let ch = 0; ch < out.numberOfChannels; ch++) {
        const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
        const dst = out.getChannelData(ch);
        const n = Math.min(src.length, dst.length - offset);
        if (n > 0) dst.set(src.subarray(0, n), offset);
      }
    }
    return out;
  } finally {
    input.dispose();
  }
}

/**
 * 動画を実際に（無音で）再生しながら音を取り込む。
 * どのブラウザでも動くが、動画の長さぶんの時間がかかる。
 */
async function captureByPlayback(
  blob: Blob,
  onProgress?: (ratio: number, label: string) => void,
): Promise<AudioBuffer | null> {
  const url = URL.createObjectURL(blob);
  const el = document.createElement('video');
  el.src = url;
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  el.setAttribute('webkit-playsinline', '');
  el.preload = 'auto';
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(el);

  const ctx = getAudioContext();
  if (!ctx) throw new Error('AudioContext を作れません');

  try {
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('loadedmetadata', () => resolve(), { once: true });
      el.addEventListener('error', () => reject(new Error('動画を読み込めません')), { once: true });
    });
    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createMediaElementSource(el);
    const processor = ctx.createScriptProcessor(4096, 2, 2);
    // 音を出さずに処理だけ回すため、音量0のノードを経由して出力につなぐ
    const silent = ctx.createGain();
    silent.gain.value = 0;

    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (e): void => {
      const input = e.inputBuffer;
      const l = input.getChannelData(0);
      const r = input.numberOfChannels > 1 ? input.getChannelData(1) : l;
      const mono = new Float32Array(l.length);
      for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
      chunks.push(mono);
    };

    source.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);

    el.muted = false;
    el.volume = 1;
    await el.play();

    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 1;
        onProgress?.(
          Math.min(0.99, el.currentTime / dur),
          `音声を取り込んでいます… ${Math.round((el.currentTime / dur) * 100)}%`,
        );
        if (el.ended || el.currentTime >= dur - 0.05) {
          window.clearInterval(timer);
          resolve();
        }
      }, 300);
      el.addEventListener(
        'ended',
        () => {
          window.clearInterval(timer);
          resolve();
        },
        { once: true },
      );
    });

    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    silent.disconnect();

    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (total === 0) return null;
    const out = new AudioBuffer({ numberOfChannels: 1, length: total, sampleRate: ctx.sampleRate });
    const data = out.getChannelData(0);
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.length;
    }
    // 無音だけなら失敗扱いにする
    let peak = 0;
    for (let i = 0; i < data.length; i += 32) peak = Math.max(peak, Math.abs(data[i]));
    if (peak < 1e-5) return null;
    return out;
  } finally {
    el.pause();
    el.remove();
    URL.revokeObjectURL(url);
  }
}
