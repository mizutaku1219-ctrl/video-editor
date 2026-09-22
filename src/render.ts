import type { Telop } from './types';

export const FONT_FAMILY = "'Noto Sans JP', system-ui, sans-serif";
/** フォントサイズの基準となる高さ。これを基準に実際の解像度へスケールする。 */
export const FONT_REFERENCE_HEIGHT = 1080;

/** Noto Sans JP の読み込みを待つ（canvas 描画に必要）。 */
export async function ensureFontsReady(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`700 64px ${FONT_FAMILY}`),
      document.fonts.load(`900 64px ${FONT_FAMILY}`),
    ]);
    await document.fonts.ready;
  } catch {
    /* フォント読み込みに失敗しても代替フォントで描画する */
  }
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of raw) {
      const next = line + ch;
      if (line !== '' && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function telopIsVisible(t: Telop, time: number): boolean {
  return time >= t.start && time < t.end && t.text.trim() !== '';
}

/** テロップの描画範囲（ドラッグ判定にも使う）。 */
export interface TelopBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function drawTelop(
  ctx: CanvasRenderingContext2D,
  telop: Telop,
  width: number,
  height: number,
  measureOnly = false,
): TelopBox {
  const scale = height / FONT_REFERENCE_HEIGHT;
  const fontSize = Math.max(8, telop.fontSize * scale);
  const lineHeight = fontSize * 1.3;
  const maxWidth = width * 0.92;

  ctx.save();
  ctx.font = `700 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapLines(ctx, telop.text, maxWidth);
  const blockHeight = lines.length * lineHeight;
  const blockWidth = Math.min(
    maxWidth,
    Math.max(...lines.map((l) => ctx.measureText(l).width), 1),
  );
  const cx = telop.x * width;
  const cy = telop.y * height;

  if (telop.bgEnabled && !measureOnly) {
    const padX = fontSize * 0.5;
    const padY = fontSize * 0.25;
    ctx.fillStyle = hexToRgba(telop.bgColor, telop.bgOpacity);
    ctx.fillRect(
      cx - blockWidth / 2 - padX,
      cy - blockHeight / 2 - padY,
      blockWidth + padX * 2,
      blockHeight + padY * 2,
    );
  }

  const strokeWidth = telop.strokeWidth * scale;
  if (!measureOnly) lines.forEach((line, i) => {
    const y = cy - blockHeight / 2 + lineHeight * (i + 0.5);
    if (strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = strokeWidth * 2;
      ctx.strokeStyle = telop.strokeColor;
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = telop.color;
    ctx.fillText(line, cx, y);
  });
  ctx.restore();

  return {
    x: cx - blockWidth / 2,
    y: cy - blockHeight / 2,
    width: blockWidth,
    height: blockHeight,
  };
}

/** 縦横比を保ったまま中央に収める位置とサイズ（足りない部分は黒帯）。 */
export function containRect(
  srcWidth: number,
  srcHeight: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  if (srcWidth <= 0 || srcHeight <= 0) return { x: 0, y: 0, w: width, h: height };
  const scale = Math.min(width / srcWidth, height / srcHeight);
  const w = srcWidth * scale;
  const h = srcHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** 映像＋テロップを1フレーム分描く。プレビューと書き出しで共通。 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource | null,
  width: number,
  height: number,
  telops: Telop[],
  time: number,
  srcSize?: { width: number; height: number },
): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  if (image) {
    try {
      if (srcSize && srcSize.width > 0 && srcSize.height > 0) {
        // 解像度や縦横比の違う動画をつなげても崩れないよう、中央に収める
        const r = containRect(srcSize.width, srcSize.height, width, height);
        ctx.drawImage(image, r.x, r.y, r.w, r.h);
      } else {
        ctx.drawImage(image, 0, 0, width, height);
      }
    } catch {
      /* まだデコードできていないフレームは無視する */
    }
  }
  for (const t of telops) {
    if (telopIsVisible(t, time)) drawTelop(ctx, t, width, height);
  }
}
