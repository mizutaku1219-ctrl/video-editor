import { decodeAudio, getDecodeReasons, type DecodeOptions } from './audio-decode';
import { bgmGainAt } from './player';
import { clipDuration, sourceOfClip, state, totalDuration } from './state';

export const EXPORT_SAMPLE_RATE = 48000;

/** ファイルから AudioBuffer を作る（複数の手段を順に試す）。 */
export function decodeToAudioBuffer(blob: Blob, options?: DecodeOptions): Promise<AudioBuffer | null> {
  return decodeAudio(blob, options ?? {});
}

export { getDecodeReasons };

/**
 * 元動画の音（カット後に連結）とBGM（音量・フェード・ループ）を
 * OfflineAudioContext で1本にミックスする。
 */
export async function mixAudio(
  withOriginal: boolean,
  bgmAudio: AudioBuffer | null,
  options?: DecodeOptions,
): Promise<AudioBuffer | null> {
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
      const buffer = source ? await decodeToAudioBuffer(source.blob, options) : null;
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
