/**
 * 共有の AudioContext。
 * iOS Safari は「ユーザー操作の中で作って resume したもの」しか音を扱えないため、
 * ボタンが押された瞬間に unlockAudio() を呼んでおく。
 */
let ctx: AudioContext | null = null;

function ctor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** ユーザー操作の中で同期的に呼ぶこと。 */
export function unlockAudio(): void {
  const C = ctor();
  if (!C) return;
  if (!ctx) {
    try {
      ctx = new C();
    } catch {
      return;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

export function getAudioContext(): AudioContext | null {
  if (!ctx) unlockAudio();
  return ctx;
}
