import { clipDuration, clipTimelineStart, emitChange, formatTime, state, timelineToSource } from './state';
import type { Player } from './player';

let lastKey = '';

/**
 * タイムライン（クリップ一覧）の描画。クリップをタップするとその先頭へ移動。
 * 再生中に毎フレーム呼ばれるので、表示が変わらないときは作り直さない。
 */
export function renderTimeline(root: HTMLElement, player: Player, force = false): void {
  const probe = timelineToSource(player.currentTime);
  const key = state.clips.map((c) => `${c.id}:${c.start.toFixed(3)}-${c.end.toFixed(3)}`).join('|') +
    `#${probe ? probe.clipIndex : -1}`;
  if (!force && key === lastKey) return;
  lastKey = key;

  root.innerHTML = '';
  if (state.clips.length === 0) return;

  const pos = timelineToSource(player.currentTime);
  const strip = document.createElement('div');
  strip.className = 'clip-strip';

  state.clips.forEach((clip, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn clip' + (pos && pos.clipIndex === i ? ' current' : '');
    btn.innerHTML =
      `<span class="clip-title">クリップ ${i + 1}</span><br>` +
      `<span class="clip-time">${formatTime(clipDuration(clip))}</span>`;
    btn.addEventListener('click', () => {
      void player.seek(clipTimelineStart(i) + 0.001).then(() => renderTimeline(root, player, true));
      emitChange(false);
    });
    strip.appendChild(btn);
  });

  root.appendChild(strip);
}
