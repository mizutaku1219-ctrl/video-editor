import { drawFrame } from './render';
import { clipDuration, clipTimelineStart, state, timelineToSource, totalDuration } from './state';

/**
 * プレビュー再生エンジン。
 * video 要素を再生しつつ、毎フレーム canvas に映像＋テロップを描く。
 */
export class Player {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
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

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.video = video;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d コンテキストを取得できませんでした');
    this.ctx = ctx;
    this.video.addEventListener('ended', () => this.pause());
  }

  get currentTime(): number {
    return this.timelineTime;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * 動画を読み込む。iPhone Safari は preload が効かず、ユーザー操作前は
   * メタデータすら読まないことがあるため、必ずユーザー操作の流れの中で呼ぶ。
   */
  async load(blob: Blob): Promise<{ duration: number; width: number; height: number }> {
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    const url = URL.createObjectURL(blob);
    state.videoUrl = url;

    const v = this.video;
    v.removeAttribute('preload');
    v.setAttribute('preload', 'auto');
    v.playsInline = true;
    v.muted = true;
    v.src = url;
    v.load();

    const meta = await new Promise<{ duration: number; width: number; height: number }>(
      (resolve, reject) => {
        const ok = () => {
          cleanup();
          resolve({
            duration: Number.isFinite(v.duration) ? v.duration : 0,
            width: v.videoWidth,
            height: v.videoHeight,
          });
        };
        const ng = () => {
          cleanup();
          reject(new Error('この動画を読み込めませんでした（対応していない形式の可能性があります）'));
        };
        const cleanup = () => {
          v.removeEventListener('loadedmetadata', ok);
          v.removeEventListener('error', ng);
        };
        v.addEventListener('loadedmetadata', ok, { once: true });
        v.addEventListener('error', ng, { once: true });
      },
    );

    // iOS ではここで一度 play()/pause() しておくとシークが安定する。
    await this.prime();

    this.canvas.width = meta.width || 1280;
    this.canvas.height = meta.height || 720;
    this.canvas.style.aspectRatio = `${meta.width || 16} / ${meta.height || 9}`;
    const box = this.canvas.parentElement;
    if (box) box.style.aspectRatio = `${meta.width || 16} / ${meta.height || 9}`;
    return meta;
  }

  /** 自動再生制限を回避するため、ユーザー操作の中で一度だけ空再生しておく。 */
  async prime(): Promise<void> {
    if (this.primed) return;
    try {
      this.video.muted = true;
      await this.video.play();
      this.video.pause();
      this.primed = true;
    } catch {
      /* 失敗しても次のユーザー操作で再試行する */
    }
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

  async seek(time: number): Promise<void> {
    const total = totalDuration();
    const t = Math.min(Math.max(time, 0), total);
    const pos = timelineToSource(t);
    if (!pos) return;
    this.clipIndex = pos.clipIndex;
    this.timelineTime = t;
    this.seeking = true;
    this.video.currentTime = pos.sourceTime;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.seeking = false;
        resolve();
      };
      this.video.addEventListener('seeked', done, { once: true });
      window.setTimeout(done, 1500);
    });
    this.syncBgm();
    this.draw();
    this.onTimeUpdate?.(this.timelineTime);
  }

  async play(): Promise<void> {
    if (state.clips.length === 0) return;
    await this.prime();
    if (this.timelineTime >= totalDuration() - 0.02) await this.seek(0);
    this.video.muted = false;
    this.video.volume = state.videoVolume;
    try {
      await this.video.play();
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
    this.video.pause();
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
    a.volume = Math.min(1, Math.max(0, bgmGainAt(this.timelineTime, total, bgm.volume, bgm.fadeIn, bgm.fadeOut)));
    if (!bgm.loop && dur > 0 && this.timelineTime > dur) a.volume = 0;
  }

  private loop = (): void => {
    if (!this.playing) return;
    this.tick();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private tick(): void {
    const clips = state.clips;
    if (clips.length === 0) return;
    const clip = clips[Math.min(this.clipIndex, clips.length - 1)];
    const v = this.video;

    if (!this.seeking && v.currentTime >= clip.end - 0.02) {
      const next = this.clipIndex + 1;
      if (next < clips.length) {
        this.clipIndex = next;
        this.seeking = true;
        v.currentTime = clips[next].start;
        v.addEventListener('seeked', () => (this.seeking = false), { once: true });
      } else {
        this.timelineTime = totalDuration();
        this.onTimeUpdate?.(this.timelineTime);
        this.pause();
        return;
      }
    }

    const cur = clips[Math.min(this.clipIndex, clips.length - 1)];
    const local = Math.min(Math.max(v.currentTime - cur.start, 0), clipDuration(cur));
    this.timelineTime = clipTimelineStart(this.clipIndex) + local;
    v.volume = state.videoVolume;
    this.syncBgm();
    this.draw();
    this.onTimeUpdate?.(this.timelineTime);
  }

  private draw(): void {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;
    drawFrame(this.ctx, this.video.readyState >= 2 ? this.video : null, width, height, state.telops, this.timelineTime);
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
