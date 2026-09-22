import './styles.css';
import { defaultBgm, renderBgmPanel } from './panel-bgm';
import { renderCutPanel } from './panel-cut';
import { renderExportPanel } from './panel-export';
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
  placeholder.hidden = state.sources.length > 0;
  playBtn.disabled = state.sources.length === 0;
  seekbar.disabled = state.sources.length === 0;
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
  id: 'export',
  label: '書き出し',
  render(root) {
    renderExportPanel(root, player, support);
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
