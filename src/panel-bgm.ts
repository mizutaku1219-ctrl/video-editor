import type { Player } from './player';
import { emitChange, state, totalDuration } from './state';
import type { BgmSettings } from './types';

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field grow';
  const l = document.createElement('label');
  l.textContent = label;
  wrap.append(l, control);
  return wrap;
}

function slider(
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'range';
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.value = String(value);
  el.addEventListener('input', () => onInput(Number(el.value)));
  return el;
}

export function defaultBgm(name: string): BgmSettings {
  return { name, volume: 0.3, fadeIn: 1, fadeOut: 1.5, loop: true };
}

export function renderBgmPanel(
  root: HTMLElement,
  player: Player,
  pickAudio: () => void,
  refresh: () => void,
): void {
  const title = document.createElement('h2');
  title.textContent = 'BGM・音量';
  root.appendChild(title);

  const volRow = document.createElement('div');
  volRow.className = 'row';
  const label = document.createElement('span');
  label.className = 'hint';
  const updateLabel = (): void => {
    label.textContent = `元動画の音量：${Math.round(state.videoVolume * 100)}%`;
  };
  updateLabel();
  volRow.appendChild(
    field(
      '元動画の音量',
      slider(0, 1, 0.05, state.videoVolume, (v) => {
        state.videoVolume = v;
        updateLabel();
        emitChange();
      }),
    ),
  );
  root.append(volRow, label);

  const pickRow = document.createElement('div');
  pickRow.className = 'row';
  const pick = document.createElement('button');
  pick.className = 'btn btn-primary';
  pick.textContent = state.bgmFile ? 'BGMを選び直す' : 'BGMを選ぶ（mp3 / m4a / wav）';
  pick.addEventListener('click', pickAudio);
  pickRow.appendChild(pick);
  if (state.bgmFile) {
    const del = document.createElement('button');
    del.className = 'btn btn-danger';
    del.textContent = 'BGMを外す';
    del.addEventListener('click', () => {
      state.bgmFile = null;
      state.bgm = null;
      player.setBgm(null);
      emitChange();
      refresh();
    });
    pickRow.appendChild(del);
  }
  root.appendChild(pickRow);

  const notice = document.createElement('p');
  notice.className = 'hint';
  notice.textContent =
    'フリーBGMは各サイトの利用規約を確認して使ってください。本アプリには音源を同梱していません。';
  root.appendChild(notice);

  const bgm = state.bgm;
  if (!bgm || !state.bgmFile) return;

  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent = `選択中：${bgm.name}`;
  root.appendChild(info);

  const bgmVolLabel = document.createElement('span');
  bgmVolLabel.className = 'hint';
  const updateBgmLabel = (): void => {
    bgmVolLabel.textContent = `BGMの音量：${Math.round(bgm.volume * 100)}%`;
  };
  updateBgmLabel();
  root.appendChild(
    field(
      'BGMの音量',
      slider(0, 1, 0.05, bgm.volume, (v) => {
        bgm.volume = v;
        updateBgmLabel();
        emitChange();
      }),
    ),
  );
  root.appendChild(bgmVolLabel);

  const total = totalDuration();
  const fadeRow = document.createElement('div');
  fadeRow.className = 'row';
  fadeRow.appendChild(
    field(
      'フェードイン(秒)',
      slider(0, Math.max(1, Math.min(10, total)), 0.5, bgm.fadeIn, (v) => {
        bgm.fadeIn = v;
        emitChange();
      }),
    ),
  );
  fadeRow.appendChild(
    field(
      'フェードアウト(秒)',
      slider(0, Math.max(1, Math.min(10, total)), 0.5, bgm.fadeOut, (v) => {
        bgm.fadeOut = v;
        emitChange();
      }),
    ),
  );
  root.appendChild(fadeRow);

  const loopBtn = document.createElement('button');
  loopBtn.className = 'btn' + (bgm.loop ? ' btn-primary' : '');
  loopBtn.textContent = bgm.loop ? 'ループ：する' : 'ループ：しない';
  loopBtn.addEventListener('click', () => {
    bgm.loop = !bgm.loop;
    emitChange();
    refresh();
  });
  root.appendChild(loopBtn);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    'プレビューの音量はだいたいの目安です。書き出し時はフェードとループを正確に計算して合成します。';
  root.appendChild(hint);
}
