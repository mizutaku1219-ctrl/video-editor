import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { decodeToAudioBuffer, mixAudio, EXPORT_SAMPLE_RATE } from './audio-mix';
import { drawFrame } from './render';
import { clipDuration, state, totalDuration } from './state';

export interface ExportOptions {
  fps: number;
  maxHeight: number;
  withAudio: boolean;
  onProgress: (ratio: number, label: string) => void;
  signal: { canceled: boolean };
}

function evenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** 出力解像度を決める（元の比率を保ったまま maxHeight まで縮小）。 */
export function outputSize(maxHeight: number): { width: number; height: number } {
  const w = state.videoWidth || 1280;
  const h = state.videoHeight || 720;
  const scale = Math.min(1, maxHeight / h);
  return { width: evenSize(w * scale), height: evenSize(h * scale) };
}

/** 編集結果を MP4 に書き出す。 */
export async function exportVideo(options: ExportOptions): Promise<Blob> {
  const { fps, onProgress, signal } = options;
  if (!state.videoFile) throw new Error('動画が読み込まれていません');
  const total = totalDuration();
  if (total <= 0) throw new Error('書き出す範囲がありません');

  const { width, height } = outputSize(options.maxHeight);

  onProgress(0, '音声を準備しています…');
  let mixedAudio: AudioBuffer | null = null;
  if (options.withAudio) {
    const videoAudio =
      state.videoVolume > 0 ? await decodeToAudioBuffer(state.videoFile) : null;
    const bgmAudio = state.bgmFile ? await decodeToAudioBuffer(state.bgmFile) : null;
    mixedAudio = await mixAudio(videoAudio, bgmAudio);
  }

  const input = new Input({ source: new BlobSource(state.videoFile), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('この動画から映像トラックを読み取れませんでした');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('canvas を準備できませんでした');

  // H.264 が使えればそれを最優先。使えない環境では VP9 にフォールバックする。
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9'], { width, height });
  if (!codec) throw new Error('この環境では映像を書き出せません');

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSource: AudioBufferSource | null = null;
  if (mixedAudio) {
    // AAC が最優先。非対応環境では Opus にフォールバックする。
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: 2,
      sampleRate: EXPORT_SAMPLE_RATE,
    });
    if (audioCodec) {
      audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 128_000 });
      output.addAudioTrack(audioSource);
    } else {
      mixedAudio = null;
    }
  }

  await output.start();

  const sink = new VideoSampleSink(videoTrack);
  const frameDuration = 1 / fps;
  const totalFrames = Math.max(1, Math.round(total * fps));
  let doneFrames = 0;

  // デコードできたフレームを溜めておく板。テロップは毎フレーム上から描き直す。
  const raw = document.createElement('canvas');
  raw.width = width;
  raw.height = height;
  const rawCtx = raw.getContext('2d', { alpha: false });
  if (!rawCtx) throw new Error('canvas を準備できませんでした');
  rawCtx.fillStyle = '#000';
  rawCtx.fillRect(0, 0, width, height);

  try {
    let timelineOffset = 0;
    for (const clip of state.clips) {
      const d = clipDuration(clip);
      if (d <= 0) continue;
      const count = Math.max(1, Math.round(d * fps));
      const timestamps: number[] = [];
      for (let i = 0; i < count; i++) {
        timestamps.push(Math.min(Math.max(clip.start, clip.end - 1e-4), clip.start + i * frameDuration));
      }

      let i = 0;
      for await (const sample of sink.samplesAtTimestamps(timestamps)) {
        if (signal.canceled) throw new Error('canceled');
        const timelineTime = timelineOffset + i * frameDuration;
        if (sample) {
          // フレームは使ったら必ず close() してメモリを解放する
          try {
            sample.draw(rawCtx, 0, 0, width, height);
          } finally {
            sample.close();
          }
        }
        drawFrame(ctx, raw, width, height, state.telops, timelineTime);
        await videoSource.add(timelineTime, frameDuration);

        i++;
        doneFrames++;
        if (doneFrames % 5 === 0 || doneFrames === totalFrames) {
          const pct = Math.min(100, Math.round((doneFrames / totalFrames) * 100));
          onProgress(Math.min(0.95, (doneFrames / totalFrames) * 0.95), `映像を書き出しています… ${pct}%`);
          // UI（進捗バー・中止ボタン）を更新する余地を作る
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      timelineOffset += count * frameDuration;
    }

    if (audioSource && mixedAudio) {
      onProgress(0.96, '音声を書き出しています…');
      await audioSource.add(mixedAudio);
      audioSource.close();
    }

    onProgress(0.99, 'MP4にまとめています…');
    await output.finalize();
  } catch (err) {
    try {
      await output.cancel();
    } catch {
      /* 後片付けの失敗は無視 */
    }
    if (err instanceof Error && err.message === 'canceled') throw new Error('書き出しを中止しました');
    throw err;
  } finally {
    videoSource.close();
    input.dispose();
  }

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('書き出しに失敗しました');
  onProgress(1, '完了しました');
  return new Blob([buffer], { type: 'video/mp4' });
}
