import { unlockAudio } from './audio-ctx';
import { exportVideo, outputSize } from './export';
import type { Player } from './player';
import { formatTime, projectSize, state, totalDuration } from './state';
import type { SupportReport } from './support';

let lastResult: { blob: Blob; name: string } | null = null;

function outputFileName(): string {
  const base = (state.sources[0]?.name || 'movie').replace(/\.[^.]+$/, '');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${base}_edited_${stamp}.mp4`;
}

function canShareFile(file: File): boolean {
  return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

export function renderExportPanel(
  root: HTMLElement,
  player: Player,
  support: SupportReport,
): void {
  const title = document.createElement('h2');
  title.textContent = '保存（MP4で書き出し）';
  root.appendChild(title);

  if (state.sources.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'まず動画を読み込んでください。';
    root.appendChild(p);
    return;
  }

  if (!support.canExport) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent =
      'この環境では書き出せません。画面上部の案内をご確認ください（HTTPS で開く / Chrome・Edge・Safari を使う）。';
    root.appendChild(p);
    return;
  }

  const settings = document.createElement('div');
  settings.className = 'row';

  const heightSelect = document.createElement('select');
  const maxSourceHeight = projectSize().height;
  const heightChoices = [480, 720, 1080].filter((h) => h <= maxSourceHeight);
  if (heightChoices.length === 0) heightChoices.push(maxSourceHeight);
  for (const h of heightChoices) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = `${h}p`;
    heightSelect.appendChild(opt);
  }
  heightSelect.value = String(heightChoices.includes(720) ? 720 : heightChoices[heightChoices.length - 1]);

  const fpsSelect = document.createElement('select');
  for (const f of [24, 30]) {
    const opt = document.createElement('option');
    opt.value = String(f);
    opt.textContent = `${f} fps`;
    fpsSelect.appendChild(opt);
  }
  fpsSelect.value = '30';

  const mkField = (label: string, el: HTMLElement): HTMLElement => {
    const w = document.createElement('div');
    w.className = 'field grow';
    const l = document.createElement('label');
    l.textContent = label;
    w.append(l, el);
    return w;
  };
  settings.append(mkField('画質（高さ）', heightSelect), mkField('フレームレート', fpsSelect));
  root.appendChild(settings);

  const audioNote = document.createElement('p');
  audioNote.className = 'hint';
  audioNote.textContent = support.aac
    ? '音声はAAC（MP4標準）で書き出します。'
    : support.opus
      ? 'この環境はAAC書き出しに非対応のため、音声はOpusになります（一部の端末で音が出ないことがあります）。'
      : 'この環境は音声書き出しに非対応のため、音声なしのMP4になります。';
  root.appendChild(audioNote);

  const info = document.createElement('p');
  info.className = 'hint';
  const updateInfo = (): void => {
    const size = outputSize(Number(heightSelect.value));
    info.textContent = `書き出し内容：${size.width}×${size.height} / 長さ ${formatTime(totalDuration())} / 動画 ${state.sources.length}本 / クリップ ${state.clips.length}個 / テロップ ${state.telops.length}件`;
  };
  updateInfo();
  heightSelect.addEventListener('change', updateInfo);
  root.appendChild(info);

  const progressWrap = document.createElement('div');
  progressWrap.className = 'progress-wrap';
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('i');
  bar.appendChild(fill);
  const progressLabel = document.createElement('span');
  progressLabel.className = 'hint';
  progressWrap.append(bar, progressLabel);
  progressWrap.hidden = true;
  root.appendChild(progressWrap);

  const actions = document.createElement('div');
  actions.className = 'row';
  const startBtn = document.createElement('button');
  startBtn.className = 'btn btn-primary';
  startBtn.textContent = 'MP4を書き出す';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-danger';
  cancelBtn.textContent = '中止';
  cancelBtn.hidden = true;
  actions.append(startBtn, cancelBtn);
  root.appendChild(actions);

  const resultBox = document.createElement('div');
  resultBox.className = 'list';
  root.appendChild(resultBox);

  const showResult = (blob: Blob, name: string): void => {
    resultBox.innerHTML = '';
    const url = URL.createObjectURL(blob);
    const sizeMb = (blob.size / 1024 / 1024).toFixed(1);

    const done = document.createElement('p');
    done.className = 'hint';
    done.textContent = `書き出しが完了しました（${sizeMb} MB）。`;
    resultBox.appendChild(done);

    const row = document.createElement('div');
    row.className = 'row';

    const dl = document.createElement('a');
    dl.className = 'btn btn-primary';
    dl.href = url;
    dl.download = name;
    dl.textContent = '保存（ダウンロード）';
    dl.style.display = 'inline-flex';
    dl.style.alignItems = 'center';
    row.appendChild(dl);

    const file = new File([blob], name, { type: 'video/mp4' });
    if (canShareFile(file)) {
      const share = document.createElement('button');
      share.className = 'btn';
      share.textContent = '共有（写真に保存）';
      share.addEventListener('click', () => {
        void navigator.share({ files: [file], title: name }).catch(() => undefined);
      });
      row.appendChild(share);
    }
    resultBox.appendChild(row);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'iPhone は「共有」から「ビデオを保存」で写真アプリに入ります。うまくいかない場合は、いったんプレビューを長押しして保存してください。';
    resultBox.appendChild(hint);

    const preview = document.createElement('video');
    preview.src = url;
    preview.controls = true;
    preview.playsInline = true;
    preview.style.width = '100%';
    preview.style.borderRadius = '12px';
    resultBox.appendChild(preview);
    // 完成したことが分かるように、結果まで画面を送る
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (lastResult) showResult(lastResult.blob, lastResult.name);

  startBtn.addEventListener('click', () => {
    unlockAudio();
    player.pause();
    const signal = { canceled: false };
    startBtn.disabled = true;
    cancelBtn.hidden = false;
    progressWrap.hidden = false;
    resultBox.innerHTML = '';
    lastResult = null;

    cancelBtn.onclick = () => {
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
        lastResult = { blob, name };
        showResult(blob, name);
      })
      .catch((err: unknown) => {
        progressLabel.textContent =
          err instanceof Error ? `書き出せませんでした：${err.message}` : '書き出せませんでした';
      })
      .finally(() => {
        startBtn.disabled = false;
        cancelBtn.hidden = true;
        cancelBtn.disabled = false;
      });
  });
}
