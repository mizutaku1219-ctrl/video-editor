import './styles.css';
import { renderAutoPanel } from './panel-auto';
import { defaultBgm, renderBgmPanel } from './panel-bgm';
import { renderCutPanel } from './panel-cut';
import { renderSaveSheet } from './save-sheet';
import { renderSourcePanel } from './panel-source';
import { attachTelopDragging, renderTelopPanel } from './panel-telop';
import { Player } from './player';
import { ensureFontsReady } from './render';
import {
  addSource,
  emitChange,
  formatTime,
  onChange,
  restoreProject,
  state,
  totalDuration,
} from './state';
import { checkSupport, type SupportReport } from './support';
import { renderTimeline } from './timeline-ui';
import { newId } from './types';

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`要素が見つかりません: ${sel}`);
  return el;
};

const videoHost = $<HTMLDivElement>('#video-host');
const canvasEl = $<HTMLCanvasElement>('#preview-canvas');
const placeholder = $<HTMLDivElement>('#preview-placeholder');
const playBtn = $<HTMLButtonElement>('#btn-playpause');
const seekbar = $<HTMLInputElement>('#seekbar');
const timeLabel = $<HTMLSpanElement>('#time-label');
const fileVideo = $<HTMLInputElement>('#file-video');
const fileAudio = $<HTMLInputElement>('#file-audio');
const banner = $<HTMLDivElement>('#support-banner');
const panel = $<HTMLDivElement>('#panel');
const toolbar = $<HTMLElement>('#toolbar');
const timelineArea = $<HTMLElement>('#timeline-area');
const saveBtn = $<HTMLButtonElement>('#btn-save');
const saveSheet = $<HTMLDivElement>('#save-sheet');
const sheetBody = $<HTMLDivElement>('#sheet-body');
const stepsEl = $<HTMLOListElement>('#steps');

export const player = new Player(videoHost, canvasEl);
export let support: SupportReport;

let seekingByUser = false;

/* ---------- 対応状況の表示 ---------- */

function renderBanner(report: SupportReport): void {
  if (report.messages.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = report.canExport ? 'banner' : 'banner error';
  banner.innerHTML =
    `<strong>${report.canExport ? 'ご注意' : 'この環境では書き出しできません'}</strong>` +
    `<ul>${report.messages.map((m) => `<li>${m}</li>`).join('')}</ul>`;
}

/* ---------- 動画の読み込み ---------- */

function markReady(): void {
  const has = state.sources.length > 0;
  placeholder.hidden = has;
  playBtn.disabled = !has;
  seekbar.disabled = !has;
  saveBtn.disabled = !has;
  updateSteps();
}

/** 上の「1 動画を選ぶ / 2 編集する / 3 保存する」の表示を更新する。 */
function updateSteps(): void {
  const has = state.sources.length > 0;
  const items = Array.from(stepsEl.children) as HTMLElement[];
  items.forEach((li) => li.classList.remove('current', 'done'));
  if (!has) {
    items[0]?.classList.add('current');
    return;
  }
  items[0]?.classList.add('done');
  if (sheetOpen) {
    items[1]?.classList.add('done');
    items[2]?.classList.add('current');
  } else {
    items[1]?.classList.add('current');
  }
}

/** 選ばれた動画を（複数でも）順番に読み込んでつなげる。 */
async function addVideos(files: File[]): Promise<void> {
  for (const file of files) {
    const id = newId('src');
    try {
      const meta = await player.loadSource(id, file);
      addSource({
        id,
        name: file.name,
        blob: file,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
      });
    } catch (err) {
      alert(`${file.name} を読み込めませんでした。${err instanceof Error ? err.message : ''}`);
    }
  }
  player.resize();
  markReady();
  await player.seek(0);
  emitChange();
  refreshPanel();
}

function pickVideo(): void {
  fileVideo.value = '';
  fileVideo.click();
}

fileVideo.addEventListener('change', () => {
  const files = Array.from(fileVideo.files ?? []);
  if (files.length > 0) void addVideos(files);
});

$('#pick-video-big').addEventListener('click', pickVideo);

/* ---------- 保存シート ---------- */

let sheetOpen = false;

function openSaveSheet(): void {
  if (state.sources.length === 0) {
    pickVideo();
    return;
  }
  player.pause();
  sheetOpen = true;
  saveSheet.hidden = false;
  document.body.style.overflow = 'hidden';
  renderSaveSheet(sheetBody, { player, support, close: closeSaveSheet });
  updateSteps();
}

function closeSaveSheet(): void {
  sheetOpen = false;
  saveSheet.hidden = true;
  document.body.style.overflow = '';
  updateSteps();
}

saveBtn.addEventListener('click', openSaveSheet);
$('#sheet-close').addEventListener('click', closeSaveSheet);
saveSheet.addEventListener('click', (e) => {
  if (e.target === saveSheet) closeSaveSheet();
});

/* ---------- 再生コントロール ---------- */

playBtn.addEventListener('click', () => player.toggle());

player.onPlayStateChange = (playing) => {
  playBtn.textContent = playing ? '❚❚' : '▶';
};

player.onTimeUpdate = (time) => {
  const total = totalDuration();
  timeLabel.textContent = `${formatTime(time)} / ${formatTime(total)}`;
  if (!seekingByUser) {
    seekbar.value = String(total > 0 ? Math.round((time / total) * 1000) : 0);
  }
  currentPanel?.onTime?.(time);
};

seekbar.addEventListener('input', () => {
  seekingByUser = true;
  const total = totalDuration();
  const t = (Number(seekbar.value) / 1000) * total;
  timeLabel.textContent = `${formatTime(t)} / ${formatTime(total)}`;
});

seekbar.addEventListener('change', () => {
  const total = totalDuration();
  const t = (Number(seekbar.value) / 1000) * total;
  void player.seek(t).then(() => {
    seekingByUser = false;
  });
});

/* ---------- ツールパネル ---------- */

export interface PanelDef {
  id: string;
  label: string;
  render: (root: HTMLElement) => void;
  onTime?: (time: number) => void;
  onStateChange?: () => void;
}

const panels: PanelDef[] = [];
let currentPanel: PanelDef | null = null;

export function registerPanel(def: PanelDef): void {
  panels.push(def);
}

function renderToolbar(): void {
  toolbar.innerHTML = '';
  for (const def of panels) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (currentPanel?.id === def.id ? ' active' : '');
    btn.textContent = def.label;
    btn.addEventListener('click', () => selectPanel(def.id));
    toolbar.appendChild(btn);
  }
}

export function selectPanel(id: string): void {
  const def = panels.find((p) => p.id === id);
  if (!def) return;
  currentPanel = def;
  renderToolbar();
  panel.innerHTML = '';
  def.render(panel);
}

export function refreshPanel(): void {
  if (!currentPanel) return;
  panel.innerHTML = '';
  currentPanel.render(panel);
}

/* ---------- パネル登録 ---------- */

registerPanel({
  id: 'source',
  label: '動画',
  render(root) {
    renderSourcePanel(root, player, pickVideo, () => {
      markReady();
      refreshPanel();
      renderTimeline(timelineArea, player, true);
    });
  },
});

registerPanel({
  id: 'auto',
  label: 'おまかせ',
  render(root) {
    renderAutoPanel(
      root,
      player,
      () => {
        refreshPanel();
        renderTimeline(timelineArea, player, true);
      },
      () => openSaveSheet(),
    );
  },
});

registerPanel({
  id: 'cut',
  label: 'カット',
  render(root) {
    renderCutPanel(root, player, () => {
      refreshPanel();
      renderTimeline(timelineArea, player, true);
    });
  },
  onTime() {
    renderTimeline(timelineArea, player);
  },
  onStateChange() {
    renderTimeline(timelineArea, player);
  },
});

registerPanel({
  id: 'telop',
  label: 'テロップ',
  render(root) {
    renderTelopPanel(root, player, () => refreshPanel());
  },
});

registerPanel({
  id: 'bgm',
  label: 'BGM',
  render(root) {
    renderBgmPanel(root, player, pickAudio, () => refreshPanel());
  },
});

registerPanel({
  id: 'save',
  label: '保存',
  render(root) {
    const box = document.createElement('div');
    box.className = 'row';
    const btn = document.createElement('button');
    btn.className = 'btn btn-save-big btn-big btn-block';
    btn.textContent = '保存画面をひらく';
    btn.addEventListener('click', openSaveSheet);
    box.appendChild(btn);
    root.appendChild(box);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '画面いちばん上の緑の「保存」ボタンからでも開けます。';
    root.appendChild(hint);
  },
});

attachTelopDragging(canvasEl, player, () => {
  if (currentPanel?.id === 'telop') refreshPanel();
});

/* ---------- BGM ---------- */

function pickAudio(): void {
  fileAudio.value = '';
  fileAudio.click();
}

fileAudio.addEventListener('change', () => {
  const f = fileAudio.files?.[0];
  if (!f) return;
  state.bgmFile = f;
  state.bgm = defaultBgm(f.name);
  player.setBgm(f);
  emitChange();
  refreshPanel();
});

/* ---------- 起動 ---------- */

onChange(() => {
  renderTimeline(timelineArea, player);
  currentPanel?.onStateChange?.();
  player.refresh();
  const total = totalDuration();
  timeLabel.textContent = `${formatTime(player.currentTime)} / ${formatTime(total)}`;
});

async function boot(): Promise<void> {
  support = await checkSupport();
  renderBanner(support);
  await ensureFontsReady();
  updateSteps();
  selectPanel('source');

  const restored = await restoreProject();
  if (restored) {
    if (state.bgmFile) player.setBgm(state.bgmFile);
    // iOS では自動で動画を読み込めないことがあるので、失敗しても無視して続行する。
    for (const s of state.sources) {
      try {
        const meta = await player.loadSource(s.id, s.blob);
        s.duration = meta.duration || s.duration;
        s.width = meta.width || s.width;
        s.height = meta.height || s.height;
      } catch {
        /* 読み込めなかった動画はそのまま */
      }
    }
    player.resize();
    markReady();
    await player.seek(0);
    renderTimeline(timelineArea, player, true);
    refreshPanel();
  }
}

void boot();
