import {
  AI_MODELS,
  defaultModel,
  segmentsToTelops,
  transcribeTimeline,
  type AiModelChoice,
} from './ai-telop';
import { runDiagnostics, type CheckResult } from './diagnose';
import { unlockAudio } from './audio-ctx';
import { buildSilenceCutClips, DEFAULT_SILENCE, type SilenceOptions } from './auto-edit';
import type { Player } from './player';
import { emitChange, formatTime, state, totalDuration } from './state';

interface AutoSettings {
  silence: boolean;
  telop: boolean;
  silenceOptions: SilenceOptions;
  model: AiModelChoice;
}

const settings: AutoSettings = {
  silence: true,
  telop: true,
  silenceOptions: { ...DEFAULT_SILENCE },
  model: defaultModel(),
};

/** 直前の状態（やり直し用）。 */
let undoSnapshot: { clips: typeof state.clips; telops: typeof state.telops } | null = null;
/** 実行結果のお知らせ（パネルを描き直しても消えないように覚えておく）。 */
let lastSummary: string | null = null;
/** 実行の経過ログ（どこまで進んだか・どこで失敗したかを残す）。 */
let logLines: { text: string; ok: boolean | null }[] = [];

function log(text: string, ok: boolean | null = null): void {
  logLines.push({ text, ok });
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field grow';
  const l = document.createElement('label');
  l.textContent = label;
  wrap.append(l, control);
  return wrap;
}

function toggleButton(label: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn' + (on ? ' btn-primary' : '');
  b.textContent = `${on ? '✓ ' : ''}${label}`;
  b.addEventListener('click', onClick);
  return b;
}

export function renderAutoPanel(
  root: HTMLElement,
  player: Player,
  refresh: () => void,
  goExport: () => void,
): void {
  const title = document.createElement('h2');
  title.textContent = 'おまかせ編集（AI）';
  root.appendChild(title);

  if (state.sources.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'まず動画を読み込んでください。';
    root.appendChild(p);
    return;
  }

  const lead = document.createElement('p');
  lead.className = 'hint';
  lead.textContent =
    '間の抜けた部分を自動で切り、しゃべった内容をAIが聞き取ってテロップにします。処理はすべて端末の中で行います。';
  root.appendChild(lead);

  const toggles = document.createElement('div');
  toggles.className = 'row';
  toggles.appendChild(
    toggleButton('無音カット', settings.silence, () => {
      settings.silence = !settings.silence;
      refresh();
    }),
  );
  toggles.appendChild(
    toggleButton('AI自動テロップ', settings.telop, () => {
      settings.telop = !settings.telop;
      refresh();
    }),
  );
  root.appendChild(toggles);

  if (settings.silence) {
    const strength = document.createElement('input');
    strength.type = 'range';
    strength.min = '-50';
    strength.max = '-25';
    strength.step = '1';
    strength.value = String(settings.silenceOptions.thresholdDb);
    const strengthLabel = document.createElement('span');
    strengthLabel.className = 'hint';
    const updateStrength = (): void => {
      strengthLabel.textContent = `カットの強さ：${settings.silenceOptions.thresholdDb} dB（右にするほどよく切れます）`;
    };
    updateStrength();
    strength.addEventListener('input', () => {
      settings.silenceOptions.thresholdDb = Number(strength.value);
      updateStrength();
    });
    root.append(field('無音カットの強さ', strength), strengthLabel);
  }

  if (settings.telop) {
    const select = document.createElement('select');
    for (const m of AI_MODELS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label} — ${m.note}`;
      select.appendChild(opt);
    }
    select.value = settings.model.id;
    select.addEventListener('change', () => {
      settings.model = AI_MODELS.find((m) => m.id === select.value) ?? AI_MODELS[1];
    });
    root.appendChild(field('AIの精度', select));

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent =
      '初回だけAIモデルのダウンロードが必要です（無料・ログイン不要）。Wi-Fi環境をおすすめします。2回目からは端末に保存されたものを使います。';
    root.appendChild(note);
  }

  if (lastSummary) {
    const done = document.createElement('div');
    done.className = 'banner ok';
    done.innerHTML = `<strong>${lastSummary}</strong>`;
    const next = document.createElement('p');
    next.className = 'hint';
    next.textContent = 'この内容でMP4として保存できます。プレビューで確認してから保存してください。';
    done.appendChild(next);
    const goRow = document.createElement('div');
    goRow.className = 'row';
    const go = document.createElement('button');
    go.className = 'btn btn-primary';
    go.textContent = 'このままMP4で保存する →';
    go.addEventListener('click', goExport);
    goRow.appendChild(go);
    done.appendChild(goRow);
    root.appendChild(done);
  }

  const logBox = document.createElement('div');
  logBox.className = 'loglist';
  const renderLog = (): void => {
    logBox.innerHTML = '';
    logBox.hidden = logLines.length === 0;
    for (const line of logLines) {
      const row = document.createElement('div');
      row.className = 'logline' + (line.ok === true ? ' ok' : line.ok === false ? ' ng' : '');
      const mark = document.createElement('span');
      mark.className = 'logmark';
      mark.textContent = line.ok === true ? '✓' : line.ok === false ? '✕' : '…';
      const text = document.createElement('span');
      text.textContent = line.text;
      row.append(mark, text);
      logBox.appendChild(row);
    }
  };
  renderLog();
  root.appendChild(logBox);

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
  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-primary';
  runBtn.textContent = 'おまかせ編集を実行';
  runBtn.disabled = !settings.silence && !settings.telop;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-danger';
  cancelBtn.textContent = '中止';
  cancelBtn.hidden = true;
  actions.append(runBtn, cancelBtn);

  if (undoSnapshot) {
    const undo = document.createElement('button');
    undo.className = 'btn';
    undo.textContent = '元に戻す';
    undo.addEventListener('click', () => {
      if (!undoSnapshot) return;
      state.clips = undoSnapshot.clips;
      state.telops = undoSnapshot.telops;
      undoSnapshot = null;
      lastSummary = null;
      emitChange();
      void player.seek(0).then(refresh);
    });
    actions.appendChild(undo);
  }
  root.appendChild(actions);

  runBtn.addEventListener('click', () => {
    // iOS 対策：操作の瞬間に音声まわりを有効化しておく
    unlockAudio();
    player.pause();
    const signal = { canceled: false };
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    progressWrap.hidden = false;
    cancelBtn.onclick = () => {
      signal.canceled = true;
      cancelBtn.disabled = true;
      progressLabel.textContent = '中止しています…';
    };
    const onProgress = (ratio: number, label: string): void => {
      fill.style.width = `${Math.round(ratio * 100)}%`;
      progressLabel.textContent = label;
    };

    logLines = [];
    renderLog();
    void runAuto(settings, signal, (ratio, label) => {
      onProgress(ratio, label);
    }, renderLog)
      .then((summary) => {
        lastSummary = summary;
        renderLog();
        progressLabel.textContent = summary;
        void player.seek(0).then(refresh);
      })
      .catch((err: unknown) => {
        lastSummary = null;
        const message = err instanceof Error ? err.message : String(err);
        log(`失敗：${message}`, false);
        renderLog();
        progressLabel.textContent = `できませんでした：${message}`;
      })
      .finally(() => {
        runBtn.disabled = false;
        cancelBtn.hidden = true;
        cancelBtn.disabled = false;
      });
  });

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    '実行後も「カット」「テロップ」から自由に手直しできます。気に入らなければ「元に戻す」で実行前に戻せます。';
  root.appendChild(hint);

  const checkRow = document.createElement('div');
  checkRow.className = 'row';
  const checkBtn = document.createElement('button');
  checkBtn.className = 'btn btn-sm';
  checkBtn.textContent = 'うまく動かないとき：自己チェック';
  checkBtn.addEventListener('click', () => {
    checkBtn.disabled = true;
    logLines = [];
    log('自己チェックを始めます…');
    renderLog();
    const onStep = (r: CheckResult): void => {
      logLines = logLines.filter((l) => l.text !== '自己チェックを始めます…');
      log(`${r.name}：${r.detail}`, r.ok);
      renderLog();
    };
    void runDiagnostics(onStep)
      .catch((err: unknown) => {
        log(`チェック中にエラー：${err instanceof Error ? err.message : String(err)}`, false);
        renderLog();
      })
      .finally(() => {
        checkBtn.disabled = false;
        log('チェック終了。✕ の行があれば、その内容を伝えてください。');
        renderLog();
      });
  });
  checkRow.appendChild(checkBtn);
  root.appendChild(checkRow);
}

async function runAuto(
  s: AutoSettings,
  signal: { canceled: boolean },
  onProgress: (ratio: number, label: string) => void,
  renderLog: () => void,
): Promise<string> {
  undoSnapshot = { clips: state.clips.map((c) => ({ ...c })), telops: state.telops.map((t) => ({ ...t })) };
  const messages: string[] = [];

  if (s.silence) {
    log('音声を読み取っています…');
    renderLog();
    onProgress(0.05, '無音部分を探しています…');
    const before = totalDuration();
    const result = await buildSilenceCutClips(s.silenceOptions, (r, label) =>
      onProgress(0.05 + r * 0.1, label),
    );
    if (signal.canceled) throw new Error('中止しました');
    if (result.clips.length > 0) {
      state.clips = result.clips;
      const after = totalDuration();
      const cut =
        after < before - 0.05
          ? `無音カット：${formatTime(before)} → ${formatTime(after)}`
          : '無音カット：切るところがありませんでした';
      messages.push(cut);
      logLines = logLines.filter((l) => l.text !== '音声を読み取っています…');
      log(cut, after < before - 0.05);
      renderLog();
    }
    emitChange();
    onProgress(0.2, '無音カットが終わりました');
  }

  if (s.telop) {
    log('AIの準備をしています…（初回はダウンロードがあります）');
    renderLog();
    const segments = await transcribeTimeline({
      model: s.model,
      signal,
      onProgress: (ratio, label) => onProgress(0.2 + ratio * 0.75, label),
    });
    if (signal.canceled) throw new Error('中止しました');
    const telops = segmentsToTelops(segments);
    state.telops = [...state.telops, ...telops];
    messages.push(`テロップ：${telops.length}件を追加`);
    logLines = logLines.filter((l) => l.text !== 'AIの準備をしています…（初回はダウンロードがあります）');
    log(`AIテロップ：${telops.length}件を追加しました`, telops.length > 0);
    renderLog();
    emitChange();
  }

  onProgress(1, '完了');
  return messages.length > 0 ? `完了しました。${messages.join(' / ')}` : '変更はありませんでした';
}
