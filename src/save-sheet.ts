import { unlockAudio } from './audio-ctx';
import { exportVideo, outputSize } from './export';
import type { Player } from './player';
import { formatTime, projectSize, state, totalDuration } from './state';
import type { SupportReport } from './support';

let lastResult: { blob: Blob; name: string; url: string } | null = null;
let running = false;

function outputFileName(): string {
  const base = (state.sources[0]?.name || 'movie').replace(/\.[^.]+$/, '');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${base}_edited_${stamp}.mp4`;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function canShareFile(file: File): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stepBox(num: number, title: string, state: 'active' | 'done' | 'waiting'): HTMLDivElement {
  const box = el('div', `save-step ${state === 'waiting' ? '' : state}`);
  const h = el('h3');
  const n = el('span', 'steps-num', state === 'done' ? '✓' : String(num));
  h.append(n, document.createTextNode(title));
  box.appendChild(h);
  return box;
}

export interface SaveSheetDeps {
  player: Player;
  support: SupportReport;
  /** シートを閉じる */
  close: () => void;
}

/** 保存シートの中身を描く。 */
export function renderSaveSheet(body: HTMLElement, deps: SaveSheetDeps): void {
  const { player, support } = deps;
  body.innerHTML = '';

  if (state.sources.length === 0) {
    body.appendChild(el('p', 'hint', 'まず動画を読み込んでください。'));
    return;
  }

  if (!support.canExport) {
    const p = el('p', 'hint');
    p.textContent =
      'この端末・ブラウザでは動画を作れません。iPhone は Safari（iOS 16 以降）、Android は Chrome、PC は Chrome / Edge でお試しください。';
    body.appendChild(p);
    return;
  }

  /* ---- 手順1：設定して作る ---- */

  const makeBox = stepBox(1, '動画ファイルを作る', lastResult ? 'done' : 'active');

  const settings = el('div', 'row');
  const heightSelect = document.createElement('select');
  const maxSourceHeight = projectSize().height;
  const choices = [480, 720, 1080].filter((h) => h <= maxSourceHeight);
  if (choices.length === 0) choices.push(maxSourceHeight);
  for (const h of choices) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = `${h}p`;
    heightSelect.appendChild(opt);
  }
  // スマホでは軽さ優先。長い動画ほど失敗しやすいため。
  const preferred = isIos() ? Math.min(720, choices[choices.length - 1]) : 720;
  heightSelect.value = String(choices.includes(preferred) ? preferred : choices[choices.length - 1]);

  const fpsSelect = document.createElement('select');
  for (const f of [24, 30]) {
    const opt = document.createElement('option');
    opt.value = String(f);
    opt.textContent = `${f} fps`;
    fpsSelect.appendChild(opt);
  }
  fpsSelect.value = '30';

  const mkField = (label: string, control: HTMLElement): HTMLElement => {
    const w = el('div', 'field grow');
    w.append(el('label', undefined, label), control);
    return w;
  };
  settings.append(mkField('画質', heightSelect), mkField('なめらかさ', fpsSelect));
  makeBox.appendChild(settings);

  const info = el('p', 'hint');
  const updateInfo = (): void => {
    const size = outputSize(Number(heightSelect.value));
    info.textContent =
      `${size.width}×${size.height} / 長さ ${formatTime(totalDuration())} / ` +
      `動画 ${state.sources.length}本・テロップ ${state.telops.length}件`;
  };
  updateInfo();
  heightSelect.addEventListener('change', updateInfo);
  makeBox.appendChild(info);

  const audioNote = el('p', 'hint');
  audioNote.textContent = support.aac
    ? '音声はAAC（MP4標準）で書き出します。'
    : support.opus
      ? 'この環境はAAC非対応のため、音声はOpusになります（一部の端末で音が出ないことがあります）。'
      : 'この環境は音声書き出しに非対応のため、音声なしのMP4になります。';
  makeBox.appendChild(audioNote);

  if (totalDuration() > 90 && isIos()) {
    const warn = el('p', 'hint');
    warn.textContent =
      '⚠ 1分半を超える動画はiPhoneでは時間がかかり、途中で止まることがあります。うまくいかない場合は画質を下げるか、短く分けてお試しください。';
    makeBox.appendChild(warn);
  }

  const progressWrap = el('div', 'progress-wrap');
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.appendChild(fill);
  const progressLabel = el('span', 'hint');
  progressWrap.append(bar, progressLabel);
  progressWrap.hidden = !running;
  makeBox.appendChild(progressWrap);

  const runBtn = el('button', lastResult ? 'btn btn-block' : 'btn btn-primary btn-big btn-block');
  runBtn.textContent = lastResult ? 'もう一度作り直す' : '動画を作る（書き出し）';
  const cancelBtn = el('button', 'btn btn-danger btn-block');
  cancelBtn.textContent = '中止';
  cancelBtn.hidden = true;
  makeBox.append(runBtn, cancelBtn);

  const note = el('p', 'hint');
  note.textContent = '動画の長さによっては数分かかります。画面を閉じずにお待ちください。';
  makeBox.appendChild(note);

  body.appendChild(makeBox);

  /* ---- 手順2：端末に保存する ---- */

  const saveBox = stepBox(2, '端末に保存する', lastResult ? 'active' : 'waiting');
  body.appendChild(saveBox);

  const renderSaveStep = (): void => {
    saveBox.querySelectorAll('.save-step-content').forEach((n) => n.remove());
    const content = el('div', 'save-step-content');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '10px';

    if (!lastResult) {
      content.appendChild(
        el('p', 'hint', '先に「動画を作る」を押してください。作り終わるとここに保存ボタンが出ます。'),
      );
      saveBox.appendChild(content);
      return;
    }

    const { blob, name, url } = lastResult;
    const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
    content.appendChild(el('p', 'hint', `できあがりました（${sizeMb} MB）。下のボタンから保存してください。`));

    const file = new File([blob], name, { type: 'video/mp4' });
    const shareable = canShareFile(file);

    if (shareable) {
      const share = el('button', 'btn btn-save-big btn-big btn-block');
      share.textContent = isIos() ? '写真に保存する（共有）' : '共有して保存';
      share.addEventListener('click', () => {
        void navigator.share({ files: [file], title: name }).catch(() => undefined);
      });
      content.appendChild(share);
      if (isIos()) {
        content.appendChild(
          el(
            'p',
            'hint',
            'タップすると共有メニューが出ます →「ビデオを保存」を選ぶと写真アプリに入ります。',
          ),
        );
      }
    }

    const dl = document.createElement('a');
    // 共有が使えない環境では、ダウンロードを一番目立たせる
    dl.className = shareable ? 'btn btn-big btn-block' : 'btn btn-save-big btn-big btn-block';
    dl.href = url;
    dl.download = name;
    dl.textContent = 'ダウンロードして保存';
    dl.style.display = 'flex';
    dl.style.alignItems = 'center';
    dl.style.justifyContent = 'center';
    dl.style.textDecoration = 'none';
    content.appendChild(dl);

    const openBtn = el('button', 'btn btn-block');
    openBtn.textContent = '新しい画面で開く（長押しで保存）';
    openBtn.addEventListener('click', () => {
      window.open(url, '_blank');
    });
    content.appendChild(openBtn);

    if (isIos()) {
      content.appendChild(
        el(
          'p',
          'hint',
          'うまく保存できないときは、下のプレビューを長押し →「ビデオを保存」でも保存できます。',
        ),
      );
    }

    const preview = document.createElement('video');
    preview.className = 'result-video';
    preview.src = url;
    preview.controls = true;
    preview.playsInline = true;
    content.appendChild(preview);

    saveBox.appendChild(content);
  };
  renderSaveStep();

  /* ---- 実行 ---- */

  runBtn.addEventListener('click', () => {
    unlockAudio();
    player.pause();
    const signal = { canceled: false };
    running = true;
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    progressWrap.hidden = false;
    fill.style.width = '0%';
    progressLabel.textContent = '準備しています…';
    if (lastResult) {
      URL.revokeObjectURL(lastResult.url);
      lastResult = null;
      saveBox.classList.remove('active');
      renderSaveStep();
    }

    cancelBtn.onclick = (): void => {
      signal.canceled = true;
      cancelBtn.disabled = true;
      progressLabel.textContent = '中止しています…';
    };

    void exportVideo({
      fps: Number(fpsSelect.value),
      maxHeight: Number(heightSelect.value),
      withAudio: support.canExportAudio,
      signal,
      onProgress: (ratio, label) => {
        fill.style.width = `${Math.round(ratio * 100)}%`;
        progressLabel.textContent = label;
      },
    })
      .then((blob) => {
        const name = outputFileName();
        lastResult = { blob, name, url: URL.createObjectURL(blob) };
        progressLabel.textContent = '完成しました。下の「保存」から端末に入れてください。';
        makeBox.classList.remove('active');
        makeBox.classList.add('done');
        saveBox.classList.add('active');
        // 完成後は保存ボタンを主役にするため、作り直しは控えめにする
        runBtn.className = 'btn btn-block';
        runBtn.textContent = 'もう一度作り直す';
        renderSaveStep();
        saveBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch((err: unknown) => {
        progressLabel.textContent =
          err instanceof Error ? `作れませんでした：${err.message}` : '作れませんでした';
      })
      .finally(() => {
        running = false;
        runBtn.disabled = false;
        cancelBtn.hidden = true;
        cancelBtn.disabled = false;
      });
  });
}

export function hasSavedResult(): boolean {
  return lastResult !== null;
}
