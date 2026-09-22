import type { Player } from './player';
import { drawTelop, telopIsVisible } from './render';
import { emitChange, formatTime, state, totalDuration } from './state';
import { newId, type Telop, type TelopAnchor } from './types';

const ANCHOR_Y: Record<Exclude<TelopAnchor, 'free'>, number> = {
  top: 0.12,
  middle: 0.5,
  bottom: 0.86,
};

export function createTelop(at: number, total: number): Telop {
  const start = Math.min(at, Math.max(0, total - 0.5));
  return {
    id: newId('telop'),
    text: 'テロップ',
    start,
    end: Math.min(total, start + 3),
    anchor: 'bottom',
    x: 0.5,
    y: ANCHOR_Y.bottom,
    fontSize: 64,
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 4,
    bgEnabled: false,
    bgColor: '#000000',
    bgOpacity: 0.5,
  };
}

function selected(): Telop | null {
  return state.telops.find((t) => t.id === state.selectedTelopId) ?? null;
}

/* ---------- プレビュー上のドラッグ移動 ---------- */

let dragAttached = false;

export function attachTelopDragging(canvas: HTMLCanvasElement, player: Player, refresh: () => void): void {
  if (dragAttached) return;
  dragAttached = true;

  let dragging: Telop | null = null;

  const toCanvasPoint = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    // canvas は object-fit: contain。実際に映像が描かれている領域を求める。
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const dispW = canvas.width * scale;
    const dispH = canvas.height * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    return { x: (e.clientX - offX) / dispW, y: (e.clientY - offY) / dispH };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const time = player.currentTime;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const p = toCanvasPoint(e);
    // 上に描かれているものから順に当たり判定する
    for (let i = state.telops.length - 1; i >= 0; i--) {
      const t = state.telops[i];
      if (!telopIsVisible(t, time)) continue;
      const box = drawTelop(ctx, t, canvas.width, canvas.height, true);
      const pad = canvas.height * 0.02;
      const px = p.x * canvas.width;
      const py = p.y * canvas.height;
      if (
        px >= box.x - pad &&
        px <= box.x + box.width + pad &&
        py >= box.y - pad &&
        py <= box.y + box.height + pad
      ) {
        dragging = t;
        state.selectedTelopId = t.id;
        canvas.setPointerCapture(e.pointerId);
        emitChange(false);
        refresh();
        break;
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const p = toCanvasPoint(e);
    dragging.x = Math.min(0.95, Math.max(0.05, p.x));
    dragging.y = Math.min(0.95, Math.max(0.05, p.y));
    dragging.anchor = 'free';
    player.refresh();
  });

  const end = (): void => {
    if (!dragging) return;
    dragging = null;
    emitChange();
    refresh();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

/* ---------- パネル ---------- */

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field grow';
  const l = document.createElement('label');
  l.textContent = label;
  wrap.append(l, control);
  return wrap;
}

export function renderTelopPanel(root: HTMLElement, player: Player, refresh: () => void): void {
  const title = document.createElement('h2');
  title.textContent = 'テロップ';
  root.appendChild(title);

  if (!state.videoFile) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'まず動画を読み込んでください。';
    root.appendChild(p);
    return;
  }

  const addRow = document.createElement('div');
  addRow.className = 'row';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'ここにテロップを追加';
  addBtn.addEventListener('click', () => {
    const t = createTelop(player.currentTime, totalDuration());
    state.telops.push(t);
    state.selectedTelopId = t.id;
    emitChange();
    refresh();
  });
  addRow.appendChild(addBtn);
  root.appendChild(addRow);

  const list = document.createElement('div');
  list.className = 'telop-list';
  for (const t of [...state.telops].sort((a, b) => a.start - b.start)) {
    const item = document.createElement('div');
    item.className = 'list-item' + (t.id === state.selectedTelopId ? ' selected' : '');
    const main = document.createElement('button');
    main.className = 'btn li-main grow';
    main.style.textAlign = 'left';
    main.innerHTML =
      `<div class="li-text">${t.text.replace(/</g, '&lt;').split('\n')[0] || '(空)'}</div>` +
      `<div class="li-sub">${formatTime(t.start)} 〜 ${formatTime(t.end)}</div>`;
    main.addEventListener('click', () => {
      state.selectedTelopId = t.id;
      void player.seek(t.start + 0.05);
      emitChange(false);
      refresh();
    });
    const del = document.createElement('button');
    del.className = 'btn btn-danger btn-sm';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      state.telops = state.telops.filter((x) => x.id !== t.id);
      if (state.selectedTelopId === t.id) state.selectedTelopId = null;
      emitChange();
      refresh();
    });
    item.append(main, del);
    list.appendChild(item);
  }
  if (state.telops.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'テロップはまだありません。';
    list.appendChild(p);
  }
  root.appendChild(list);

  const t = selected();
  if (!t) return;

  const editor = document.createElement('div');
  editor.className = 'list';

  const text = document.createElement('textarea');
  text.value = t.text;
  text.placeholder = '表示する文字（改行できます）';
  text.addEventListener('input', () => {
    t.text = text.value;
    player.refresh();
    emitChange();
  });
  editor.appendChild(field('文字', text));

  const timeRow = document.createElement('div');
  timeRow.className = 'row';
  const total = totalDuration();
  const mkTime = (label: string, get: () => number, set: (v: number) => void): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'row grow';
    const num = document.createElement('input');
    num.type = 'number';
    num.step = '0.1';
    num.min = '0';
    num.max = String(total.toFixed(2));
    num.value = get().toFixed(2);
    num.addEventListener('change', () => {
      set(Number(num.value));
      player.refresh();
      emitChange();
      refresh();
    });
    const now = document.createElement('button');
    now.className = 'btn btn-sm';
    now.textContent = '現在位置';
    now.addEventListener('click', () => {
      set(player.currentTime);
      num.value = get().toFixed(2);
      player.refresh();
      emitChange();
      refresh();
    });
    wrap.append(num, now);
    return field(label, wrap);
  };
  timeRow.appendChild(
    mkTime('開始(秒)', () => t.start, (v) => (t.start = Math.min(Math.max(0, v), t.end - 0.1))),
  );
  timeRow.appendChild(
    mkTime('終了(秒)', () => t.end, (v) => (t.end = Math.max(Math.min(total, v), t.start + 0.1))),
  );
  editor.appendChild(timeRow);

  const posRow = document.createElement('div');
  posRow.className = 'row';
  (['top', 'middle', 'bottom'] as const).forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn' + (t.anchor === a ? ' btn-primary' : '');
    b.textContent = { top: '上', middle: '中央', bottom: '下' }[a];
    b.addEventListener('click', () => {
      t.anchor = a;
      t.x = 0.5;
      t.y = ANCHOR_Y[a];
      player.refresh();
      emitChange();
      refresh();
    });
    posRow.appendChild(b);
  });
  const dragHint = document.createElement('span');
  dragHint.className = 'hint';
  dragHint.textContent = 'プレビュー上を指でドラッグしても動かせます';
  posRow.appendChild(dragHint);
  editor.appendChild(field('位置', posRow));

  const size = document.createElement('input');
  size.type = 'range';
  size.min = '20';
  size.max = '160';
  size.step = '2';
  size.value = String(t.fontSize);
  size.addEventListener('input', () => {
    t.fontSize = Number(size.value);
    player.refresh();
    emitChange();
  });
  editor.appendChild(field('文字サイズ', size));

  const colorRow = document.createElement('div');
  colorRow.className = 'row';
  const color = document.createElement('input');
  color.type = 'color';
  color.value = t.color;
  color.addEventListener('input', () => {
    t.color = color.value;
    player.refresh();
    emitChange();
  });
  colorRow.appendChild(field('文字色', color));

  const stroke = document.createElement('input');
  stroke.type = 'color';
  stroke.value = t.strokeColor;
  stroke.addEventListener('input', () => {
    t.strokeColor = stroke.value;
    player.refresh();
    emitChange();
  });
  colorRow.appendChild(field('縁の色', stroke));
  editor.appendChild(colorRow);

  const strokeW = document.createElement('input');
  strokeW.type = 'range';
  strokeW.min = '0';
  strokeW.max = '16';
  strokeW.step = '1';
  strokeW.value = String(t.strokeWidth);
  strokeW.addEventListener('input', () => {
    t.strokeWidth = Number(strokeW.value);
    player.refresh();
    emitChange();
  });
  editor.appendChild(field('縁取りの太さ（0で無し）', strokeW));

  const bgRow = document.createElement('div');
  bgRow.className = 'row';
  const bgToggle = document.createElement('button');
  bgToggle.className = 'btn' + (t.bgEnabled ? ' btn-primary' : '');
  bgToggle.textContent = t.bgEnabled ? '背景帯：あり' : '背景帯：なし';
  bgToggle.addEventListener('click', () => {
    t.bgEnabled = !t.bgEnabled;
    player.refresh();
    emitChange();
    refresh();
  });
  bgRow.appendChild(bgToggle);
  const bgColor = document.createElement('input');
  bgColor.type = 'color';
  bgColor.value = t.bgColor;
  bgColor.addEventListener('input', () => {
    t.bgColor = bgColor.value;
    player.refresh();
    emitChange();
  });
  bgRow.appendChild(field('帯の色', bgColor));
  const bgOpacity = document.createElement('input');
  bgOpacity.type = 'range';
  bgOpacity.min = '0';
  bgOpacity.max = '1';
  bgOpacity.step = '0.05';
  bgOpacity.value = String(t.bgOpacity);
  bgOpacity.addEventListener('input', () => {
    t.bgOpacity = Number(bgOpacity.value);
    player.refresh();
    emitChange();
  });
  bgRow.appendChild(field('帯の濃さ', bgOpacity));
  editor.appendChild(bgRow);

  root.appendChild(editor);
}
