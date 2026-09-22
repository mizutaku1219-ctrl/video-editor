/** 1つの映像クリップ。start/end は「元動画の中での秒数」。 */
export interface Clip {
  id: string;
  start: number;
  end: number;
}

export type TelopAnchor = 'top' | 'middle' | 'bottom' | 'free';

/** テロップ1件。時間はタイムライン（編集後）の秒数。 */
export interface Telop {
  id: string;
  text: string;
  start: number;
  end: number;
  anchor: TelopAnchor;
  /** 画面内の相対位置（0〜1）。anchor が free 以外でも x は使う。 */
  x: number;
  y: number;
  /** 高さ1080pxの動画を基準にしたフォントサイズ(px)。 */
  fontSize: number;
  color: string;
  strokeColor: string;
  /** 縁取りの太さ（0で無し）。fontSize と同じ基準のpx。 */
  strokeWidth: number;
  bgEnabled: boolean;
  bgColor: string;
  bgOpacity: number;
}

/** BGM設定。音源そのものは Blob で別管理。 */
export interface BgmSettings {
  name: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
}

/** IndexedDB に保存するプロジェクト。 */
export interface ProjectData {
  videoName: string;
  clips: Clip[];
  telops: Telop[];
  videoVolume: number;
  bgm: BgmSettings | null;
  updatedAt: number;
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
