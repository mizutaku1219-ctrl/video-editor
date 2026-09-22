import type { Player } from './player';
import {
  clipDuration,
  clipTimelineStart,
  emitChange,
  formatTime,
  makeClip,
  state,
  timelineToSource,
  totalDuration,
} from './state';

const MIN_CLIP = 0.1;

function currentIndex(player: Player): number {
  const pos = timelineToSource(player.currentTime);
  return pos ? pos.clipIndex : 0;
}

/** 現在の再生位置でクリップを2つに分ける。 */
export function splitAtPlayhead(player: Player): string | null {
  const pos = timelineToSource(player.currentTime);
  if (!pos) return '動画がありません';
  const clip = state.clips[pos.clipIndex];
  const at = pos.sourceTime;
  if (at - clip.start < MIN_CLIP || clip.end - at < MIN_CLIP) {
    return 'クリップの端すぎる位置では分割できません';
  }
  const left = makeClip(clip.start, at);
  const right = makeClip(at, clip.end);
  state.clips.splice(pos.clipIndex, 1, left, right);
  emitChange();
  return null;
}

/** 再生位置を、いま選んでいるクリップの開始／終了にする（トリミング）。 */
export function trimAtPlayhead(player: Player, side: 'start' | 'end'): string | null {
  const pos = timelineToSource(player.currentTime);
  if (!pos) return '動画がありません';
  const clip = state.clips[pos.clipIndex];
  if (side === 'start') {
    if (clip.end - pos.sourceTime < MIN_CLIP) return 'これ以上短くできません';
    clip.start = pos.sourceTime;
  } else {
    if (pos.sourceTime - clip.start < MIN_CLIP) return 'これ以上短くできません';
    clip.end = pos.sourceTime;
  }
  emitChange();
  return null;
}

export function deleteClip(index: number): string | null {
  if (state.clips.length <= 1) return 'クリップが1つだけのときは削除できません';
  state.clips.splice(index, 1);
  emitChange();
  return null;
}

export function moveClip(index: number, dir: -1 | 1): void {
  const to = index + dir;
  if (to < 0 || to >= state.clips.length) return;
  const [c] = state.clips.splice(index, 1);
  state.clips.splice(to, 0, c);
  emitChange();
}

export function renderCutPanel(root: HTMLElement, player: Player, refresh: () => void): void {
  const idx = currentIndex(player);
  const clip = state.clips[idx];

  const title = document.createElement('h2');
  title.textContent = 'カット編集';
  root.appendChild(title);

  if (!clip) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'まず動画を読み込んでください。';
    root.appendChild(p);
    return;
  }

  const status = document.createElement('p');
  status.className = 'hint';
  status.textContent =
    `選択中：クリップ ${idx + 1} / ${state.clips.length}（元動画 ${formatTime(clip.start)}〜${formatTime(clip.end)}、` +
    `長さ ${formatTime(clipDuration(clip))}）　全体 ${formatTime(totalDuration())}`;
  root.appendChild(status);

  const message = document.createElement('p');
  message.className = 'hint';
  const say = (msg: string | null) => {
    message.textContent = msg ?? '';
    refresh();
  };

  const mkBtn = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };

  const row1 = document.createElement('div');
  row1.className = 'row';
  row1.appendChild(mkBtn('ここで分割', 'btn-primary', () => say(splitAtPlayhead(player))));
  row1.appendChild(mkBtn('ここを先頭に', '', () => say(trimAtPlayhead(player, 'start'))));
  row1.appendChild(mkBtn('ここを末尾に', '', () => say(trimAtPlayhead(player, 'end'))));
  root.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'row';
  row2.appendChild(
    mkBtn('← 前へ移動', '', () => {
      moveClip(idx, -1);
      void player.seek(clipTimelineStart(Math.max(0, idx - 1)) + 0.001).then(refresh);
    }),
  );
  row2.appendChild(
    mkBtn('後ろへ移動 →', '', () => {
      moveClip(idx, 1);
      void player
        .seek(clipTimelineStart(Math.min(state.clips.length - 1, idx + 1)) + 0.001)
        .then(refresh);
    }),
  );
  row2.appendChild(
    mkBtn('このクリップを削除', 'btn-danger', () => {
      const err = deleteClip(idx);
      if (err) {
        say(err);
        return;
      }
      void player.seek(clipTimelineStart(Math.max(0, idx - 1)) + 0.001).then(refresh);
    }),
  );
  root.appendChild(row2);

  root.appendChild(message);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'シークバーで位置を決めてから操作してください。いらない部分は「ここで分割」→「このクリップを削除」で取り除けます。';
  root.appendChild(hint);
}
