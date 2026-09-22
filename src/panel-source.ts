import type { Player } from './player';
import { clipTimelineStart, emitChange, formatTime, makeClip, projectSize, state } from './state';

/** 「動画」パネル：読み込んだ動画の一覧と追加・削除。 */
export function renderSourcePanel(
  root: HTMLElement,
  player: Player,
  pickVideo: () => void,
  refresh: () => void,
): void {
  const title = document.createElement('h2');
  title.textContent = '動画';
  root.appendChild(title);

  const row = document.createElement('div');
  row.className = 'row';
  const pick = document.createElement('button');
  pick.className = 'btn btn-primary';
  pick.textContent = state.sources.length === 0 ? '動画を選ぶ' : '動画を追加する';
  pick.addEventListener('click', pickVideo);
  row.appendChild(pick);
  root.appendChild(row);

  if (state.sources.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      '端末の中の動画を選んでください。アップロードはしません。複数選ぶと、選んだ順につながります。';
    root.appendChild(hint);
    return;
  }

  const list = document.createElement('div');
  list.className = 'list';
  state.sources.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'list-item';

    const main = document.createElement('button');
    main.className = 'btn li-main grow';
    main.style.textAlign = 'left';
    main.innerHTML =
      `<div class="li-text">${i + 1}. ${s.name.replace(/</g, '&lt;')}</div>` +
      `<div class="li-sub">${s.width}×${s.height} / ${formatTime(s.duration)}</div>`;
    main.addEventListener('click', () => {
      const index = state.clips.findIndex((c) => c.sourceId === s.id);
      if (index >= 0) void player.seek(clipTimelineStart(index) + 0.001);
    });

    const addBack = document.createElement('button');
    addBack.className = 'btn btn-sm';
    addBack.textContent = '末尾に追加';
    addBack.title = '同じ動画をもう一度つなぐ';
    addBack.addEventListener('click', () => {
      state.clips.push(makeClip(s.id, 0, s.duration));
      emitChange();
      refresh();
    });

    const del = document.createElement('button');
    del.className = 'btn btn-danger btn-sm';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (state.sources.length === 1 && !confirm('この動画を削除すると編集内容がなくなります。よろしいですか？')) return;
      state.sources = state.sources.filter((x) => x.id !== s.id);
      state.clips = state.clips.filter((c) => c.sourceId !== s.id);
      player.disposeSource(s.id);
      player.resize();
      emitChange();
      void player.seek(0).then(refresh);
    });

    item.append(main, addBack, del);
    list.appendChild(item);
  });
  root.appendChild(list);

  const size = projectSize();
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent =
    `出力サイズは読み込んだ動画のうち最大の ${size.width}×${size.height} です。` +
    '縦横比の違う動画は、はみ出さないように黒帯を入れて中央に配置します。';
  root.appendChild(info);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent =
    '合計3分程度までがおすすめです。編集中の内容は端末内（IndexedDB）に自動保存されます。';
  root.appendChild(note);
}
