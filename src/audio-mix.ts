import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { bgmGainAt } from './player';
import { clipDuration, sourceOfClip, state, totalDuration } from './state';

export const EXPORT_SAMPLE_RATE = 48000;

const cache = new Map<Blob, AudioBuffer | null>();

/** ファイルから AudioBuffer を作る。まず decodeAudioData、だめなら Mediabunny で読む。 */
export async function decodeToAudioBuffer(blob: Blob): Promise<AudioBuffer | null> {
  if (cache.has(blob)) return cache.get(blob) ?? null;
  const result = await decodeUncached(blob);
  cache.set(blob, result);
  return result;
}

async function decodeUncached(blob: Blob): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(2, EXPORT_SAMPLE_RATE, EXPORT_SAMPLE_RATE);
  try {
    const buf = await blob.arrayBuffer();
    return await ctx.decodeAudioData(buf);
  } catch {
    /* mp4 の音声などは decodeAudioData が失敗することがあるので下でやり直す */
  }
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const sink = new AudioBufferSink(track);
    const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
    let channels = 0;
    let rate = EXPORT_SAMPLE_RATE;
    let end = 0;
    for await (const wrapped of sink.buffers()) {
      chunks.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp });
      channels = Math.max(channels, wrapped.buffer.numberOfChannels);
      rate = wrapped.buffer.sampleRate;
      end = Math.max(end, wrapped.timestamp + wrapped.duration);
    }
    input.dispose();
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
  } catch {
    return null;
  }
}

/**
 * 元動画の音（カット後に連結）とBGM（音量・フェード・ループ）を
 * OfflineAudioContext で1本にミックスする。
 */
export async function mixAudio(withOriginal: boolean, bgmAudio: AudioBuffer | null): Promise<AudioBuffer | null> {
  const total = totalDuration();
  if (total <= 0) return null;

  const ctx = new OfflineAudioContext(2, Math.ceil(total * EXPORT_SAMPLE_RATE), EXPORT_SAMPLE_RATE);
  let hasAnything = false;

  if (withOriginal && state.videoVolume > 0) {
    let at = 0;
    for (const clip of state.clips) {
      const d = clipDuration(clip);
      if (d <= 0) continue;
      const source = sourceOfClip(clip);
      const buffer = source ? await decodeToAudioBuffer(source.blob) : null;
      if (buffer) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = state.videoVolume;
        src.connect(gain).connect(ctx.destination);
        const available = Math.max(0, buffer.duration - clip.start);
        if (available > 0) {
          src.start(at, clip.start, Math.min(d, available));
          hasAnything = true;
        }
      }
      at += d;
    }
  }

  const bgm = state.bgm;
  if (bgmAudio && bgm && bgm.volume > 0) {
    const src = ctx.createBufferSource();
    src.buffer = bgmAudio;
    src.loop = bgm.loop;
    if (bgm.loop) {
      src.loopStart = 0;
      src.loopEnd = bgmAudio.duration;
    }
    const gain = ctx.createGain();
    // フェードは 0.05 秒刻みの折れ線で表現する（プレビューと同じ計算）。
    const step = 0.05;
    gain.gain.setValueAtTime(bgmGainAt(0, total, bgm.volume, bgm.fadeIn, bgm.fadeOut), 0);
    for (let t = step; t <= total; t += step) {
      gain.gain.linearRampToValueAtTime(bgmGainAt(t, total, bgm.volume, bgm.fadeIn, bgm.fadeOut), t);
    }
    src.connect(gain).connect(ctx.destination);
    src.start(0);
    src.stop(total);
    hasAnything = true;
  }

  if (!hasAnything) return null;
  return ctx.startRendering();
}
