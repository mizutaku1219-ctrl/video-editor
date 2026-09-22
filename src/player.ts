import { drawFrame } from './render';
import {
  clipDuration,
  clipTimelineStart,
  projectSize,
  sourceOfClip,
  state,
  timelineToSource,
  totalDuration,
} from './state';
import type { VideoSource } from './types';

interface SourceMedia {
  video: HTMLVideoElement;
  url: string;
}

/**
 * プレビュー再生エンジン。
 * 動画ごとに video 要素を持ち、クリップの切り替わりで再生する要素を差し替える。
 * 毎フレーム canvas に映像＋テロップを描く。
 */
export class Player {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLElement;
  private media = new Map<string, SourceMedia>();
  private bgmAudio: HTMLAudioElement | null = null;
  private bgmUrl: string | null = null;
  private rafId = 0;
  private clipIndex = 0;
  private timelineTime = 0;
  private playing = false;
  private seeking = false;
  /** iOS Safari 対策。ユーザー操作を一度受けたか。 */
  private primed = false;

  onTimeUpdate: ((time: number) => void) | null = null;
  onPlayStateChange: ((playing: boolean) => void) | null = null;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement) {
    this.container = container;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d コンテキストを取得できませんでした');
    this.ctx = ctx;
  }

  get currentTime(): number {
    return this.timelineTime;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private activeVideo(): HTMLVideoElement | null {
    const clip = state.clips[Math.min(this.clipIndex, state.clips.length - 1)];
    if (!clip) return null;
    return this.media.get(clip.sourceId)?.video ?? null;
  }

  private activeSource(): VideoSource | null {
    const clip = state.clips[Math.min(this.clipIndex, state.clips.length - 1)];
    return clip ? sourceOfClip(clip) : null;
  }

  /**
   * 動画ファイルを読み込んで長さと解像度を返す。
   * iPhone Safari は preload が効かず、ユーザー操作前はメタデータすら読まないことが
   * あるため、必ずユーザー操作の流れの中で呼ぶ。
   */
  async loadSource(id: string, blob: Blob): Promise<{ duration: number; width: number; height: number }> {
    this.disposeSource(id);
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    v.muted = true;
    this.container.appendChild(v);
    v.src = url;
    v.load();
    this.media.set(id, { video: v, url });

    const meta = await new Promise<{ duration: number; width: number; height: number }>(
      (resolve, reject) => {
        const ok = (): void => {
          cleanup();
          resolve({
            duration: Number.isFinite(v.duration) ? v.duration : 0,
            width: v.videoWidth,
            height: v.videoHeight,
          });
        };
        const ng = (): void => {
          cleanup();
          reject(new Error('この動画を読み込めませんでした（対応していない形式の可能性があります）'));
        };
        const cleanup = (): void => {
          v.removeEventListener('loadedmetadata', ok);
          v.removeEventListener('error', ng);
        };
        v.addEventListener('loadedmetadata', ok, { once: true });
        v.addEventListener('error', ng, { once: true });
      },
    );

    await this.primeVideo(v);
    return meta;
  }

  disposeSource(id: string): void {
    const m = this.media.get(id);
    if (!m) return;
    m.video.pause();
    m.video.removeAttribute('src');
    m.video.load();
    m.video.remove();
    URL.revokeObjectURL(m.url);
    this.media.delete(id);
  }

  /** キャンバスをプロジェクトの解像度に合わせる。 */
  resize(): void {
    const { width, height } = projectSize();
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.aspectRatio = `${width} / ${height}`;
    const box = this.canvas.parentElement;
    if (box) box.style.aspectRatio = `${width} / ${height}`;
  }

  /** 自動再生制限を回避するため、ユーザー操作の中で一度だけ空再生しておく。 */
  private async primeVideo(v: HTMLVideoElement): Promise<void> {
    try {
      v.muted = true;
      await v.play();
      v.pause();
    } catch {
      /* 失敗しても次のユーザー操作で再試行する */
    }
  }

  async prime(): Promise<void> {
    if (this.primed) return;
    for (const m of this.media.values()) await this.primeVideo(m.video);
    this.primed = true;
  }

  setBgm(blob: Blob | null): void {
    if (this.bgmUrl) {
      URL.revokeObjectURL(this.bgmUrl);
      this.bgmUrl = null;
    }
    if (this.bgmAudio) {
      this.bgmAudio.pause();
      this.bgmAudio = null;
    }
    if (!blob) return;
    this.bgmUrl = URL.createObjectURL(blob);
    const a = new Audio(this.bgmUrl);
    a.preload = 'auto';
    a.loop = false;
    this.bgmAudio = a;
  }

  private pauseOthers(except: HTMLVideoElement | null): void {
    for (const m of this.media.values()) {
      if (m.video !== except && !m.video.paused) m.video.pause();
    }
  }

  async seek(time: number): Promise<void> {
    const total = totalDuration();
    const t = Math.min(Math.max(time, 0), total);
    const pos = timelineToSource(t);
    if (!pos) return;
    this.clipIndex = pos.clipIndex;
    this.timelineTime = t;
    const v = this.activeVideo();
    if (v) {
      this.pauseOthers(v);
      this.seeking = true;
      v.currentTime = pos.sourceTime;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.seeking = false;
          resolve();
        };
        v.addEventListener('seeked', done, { once: true });
        window.setTimeout(done, 1500);
      });
    }
    this.syncBgm();
    this.draw();
    this.onTimeUpdate?.(this.timelineTime);
  }

  async play(): Promise<void> {
    if (state.clips.length === 0) return;
    await this.prime();
    if (this.timelineTime >= totalDuration() - 0.02) await this.seek(0);
    const v = this.activeVideo();
    if (!v) return;
    this.pauseOthers(v);
    v.muted = false;
    v.volume = state.videoVolume;
    try {
      await v.play();
    } catch {
      // ユーザー操作なしの再生は拒否される
      return;
    }
    this.playing = true;
    this.startBgm();
    this.onPlayStateChange?.(true);
    this.loop();
  }

  pause(): void {
    this.playing = false;
    this.pauseOthers(null);
    this.bgmAudio?.pause();
    cancelAnimationFrame(this.rafId);
    this.onPlayStateChange?.(false);
    this.draw();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** クリップ構成やテロップが変わったときに現在フレームを描き直す。 */
  refresh(): void {
    this.draw();
  }

  private startBgm(): void {
    const a = this.bgmAudio;
    if (!a || !state.bgm) return;
    this.syncBgm();
    void a.play().catch(() => undefined);
  }

  private syncBgm(): void {
    const a = this.bgmAudio;
    const bgm = state.bgm;
    if (!a || !bgm) return;
    const total = totalDuration();
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    let target = this.timelineTime;
    if (dur > 0) target = bgm.loop ? this.timelineTime % dur : Math.min(this.timelineTime, dur);
    if (Math.abs(a.currentTime - target) > 0.3) {
      try {
        a.currentTime = target;
      } catch {
        /* 読み込み前のシークは無視 */
      }
    }
    a.volume = Math.min(
      1,
      Math.max(0, bgmGainAt(this.timelineTime, total, bgm.volume, bgm.fadeIn, bgm.fadeOut)),
    );
    if (!bgm.loop && dur > 0 && this.timelineTime > dur) a.volume = 0;
  }

  private loop = (): void => {
    if (!this.playing) return;
    this.tick();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private async gotoClip(index: number): Promise<void> {
    const clip = state.clips[index];
    if (!clip) return;
    const v = this.media.get(clip.sourceId)?.video;
    if (!v) return;
    this.clipIndex = index;
    this.pauseOthers(v);
    this.seeking = true;
    v.currentTime = clip.start;
    v.volume = state.videoVolume;
    v.muted = false;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      v.addEventListener('seeked', done, { once: true });
      window.setTimeout(done, 1200);
    });
    this.seeking = false;
    if (this.playing) void v.play().catch(() => undefined);
  }

  private tick(): void {
    const clips = state.clips;
    if (clips.length === 0) return;
    const clip = clips[Math.min(this.clipIndex, clips.length - 1)];
    const v = this.activeVideo();
    if (!v) return;

    if (!this.seeking && v.currentTime >= clip.end - 0.02) {
      const next = this.clipIndex + 1;
      if (next < clips.length) {
        void this.gotoClip(next);
      } else {
        this.timelineTime = totalDuration();
        this.onTimeUpdate?.(this.timelineTime);
        this.pause();
        return;
      }
    }

    const cur = clips[Math.min(this.clipIndex, clips.length - 1)];
    const curVideo = this.activeVideo();
    if (curVideo) {
      const local = Math.min(Math.max(curVideo.currentTime - cur.start, 0), clipDuration(cur));
      this.timelineTime = clipTimelineStart(this.clipIndex) + local;
      curVideo.volume = state.videoVolume;
    }
    this.syncBgm();
    this.draw();
    this.onTimeUpdate?.(this.timelineTime);
  }

  private draw(): void {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;
    const v = this.activeVideo();
    const src = this.activeSource();
    drawFrame(
      this.ctx,
      v && v.readyState >= 2 ? v : null,
      width,
      height,
      state.telops,
      this.timelineTime,
      src ? { width: src.width, height: src.height } : undefined,
    );
  }
}

/** BGM のフェードを考慮した音量（0〜1）。書き出し側と同じ計算。 */
export function bgmGainAt(
  time: number,
  total: number,
  volume: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let g = volume;
  if (fadeIn > 0 && time < fadeIn) g *= time / fadeIn;
  if (fadeOut > 0 && time > total - fadeOut) g *= Math.max(0, (total - time) / fadeOut);
  return Math.max(0, g);
}
