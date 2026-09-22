import './styles.css';
import { renderCutPanel } from './panel-cut';
import { defaultBgm, renderBgmPanel } from './panel-bgm';
import { renderExportPanel } from './panel-export';
import { attachTelopDragging, renderTelopPanel } from './panel-telop';
import { Player } from './player';
import { ensureFontsReady } from './render';
import {
  emitChange,
  formatTime,
  onChange,
  resetForNewVideo,
  restoreProject,
  state,
  totalDuration,
} from './state';
import { checkSupport, type SupportReport } from './support';
import { renderTimeline } from './timeline-ui';

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`要素が見つかりません: ${sel}`);
  return el;
};

const videoEl = $<HTMLVideoElement>('#source-video');
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

export const player = new Player(videoEl, canvasEl);
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

async function loadVideo(blob: Blob, name: string, keepEdits = false): Promise<void> {
  try {
    const meta = await player.load(blob);
    state.videoFile = blob;
    state.videoName = name;
    if (!keepEdits || state.clips.length === 0) {
      resetForNewVideo(meta.duration, meta.width, meta.height);
    } else {
      state.videoDuration = meta.duration;
      state.videoWidth = meta.width;
      state.videoHeight = meta.height;
    }
    placeholder.hidden = true;
    playBtn.disabled = false;
    seekbar.disabled = false;
    await player.seek(0);
    emitChange();
  } catch (err) {
    alert(err instanceof Error ? err.message : '動画を読み込めませんでした');
  }
}

function pickVideo(): void {
  fileVideo.value = '';
  fileVideo.click();
}

fileVideo.addEventListener('change', () => {
  const f = fileVideo.files?.[0];
  if (f) void loadVideo(f, f.name);
});

$('#pick-video-big').addEventListener('click', pickVideo);

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

/* ---------- 「動画」パネル ---------- */

registerPanel({
  id: 'source',
  label: '動画',
  render(root) {
    const box = document.createElement('div');
    box.className = 'row';
    const pick = document.createElement('button');
    pick.className = 'btn btn-primary';
    pick.textContent = state.videoFile ? '別の動画を選ぶ' : '動画を選ぶ';
    pick.addEventListener('click', pickVideo);
    box.appendChild(pick);
    root.appendChild(box);

    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = state.videoFile
      ? `${state.videoName || '(名前なし)'} / ${state.videoWidth}×${state.videoHeight} / 長さ ${formatTime(state.videoDuration)}`
      : '端末の中の動画を選んでください。アップロードはしません。';
    root.appendChild(info);

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent =
      '3分程度までの短い動画に向いています。編集中の内容は端末内（IndexedDB）に自動保存されます。';
    root.appendChild(note);
  },
});

/* ---------- 「カット」パネル ---------- */

registerPanel({
  id: 'cut',
  label: 'カット',
  render(root) {
    renderCutPanel(root, player, () => {
      refreshPanel();
      renderTimeline(timelineArea, player);
    });
  },
  onTime() {
    renderTimeline(timelineArea, player);
  },
  onStateChange() {
    renderTimeline(timelineArea, player);
  },
});

/* ---------- 「テロップ」パネル ---------- */

registerPanel({
  id: 'telop',
  label: 'テロップ',
  render(root) {
    renderTelopPanel(root, player, () => refreshPanel());
  },
});

attachTelopDragging(canvasEl, player, () => {
  if (currentPanel?.id === 'telop') refreshPanel();
});

/* ---------- 「BGM」パネル ---------- */

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

registerPanel({
  id: 'bgm',
  label: 'BGM',
  render(root) {
    renderBgmPanel(root, player, pickAudio, () => refreshPanel());
  },
});

/* ---------- 「書き出し」パネル ---------- */

registerPanel({
  id: 'export',
  label: '書き出し',
  render(root) {
    renderExportPanel(root, player, support);
  },
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
  selectPanel('source');

  const restored = await restoreProject();
  if (restored && state.bgmFile) player.setBgm(state.bgmFile);
  if (restored && state.videoFile) {
    // iOS では自動で動画を読み込めないことがあるので、失敗しても無視して続行する。
    await loadVideo(state.videoFile, state.videoName, true);
  }
}

void boot();
