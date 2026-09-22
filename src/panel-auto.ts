import { AI_MODELS, segmentsToTelops, transcribeTimeline, type AiModelChoice } from './ai-telop';
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
  model: AI_MODELS[1],
};

/** 直前の状態（やり直し用）。 */
let undoSnapshot: { clips: typeof state.clips; telops: typeof state.telops } | null = null;

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

export function renderAutoPanel(root: HTMLElement, player: Player, refresh: () => void): void {
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
      emitChange();
      void player.seek(0).then(refresh);
    });
    actions.appendChild(undo);
  }
  root.appendChild(actions);

  runBtn.addEventListener('click', () => {
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

    void runAuto(settings, signal, onProgress)
      .then((summary) => {
        progressLabel.textContent = summary;
        void player.seek(0).then(refresh);
      })
      .catch((err: unknown) => {
        progressLabel.textContent =
          err instanceof Error ? `できませんでした：${err.message}` : 'できませんでした';
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
}

async function runAuto(
  s: AutoSettings,
  signal: { canceled: boolean },
  onProgress: (ratio: number, label: string) => void,
): Promise<string> {
  undoSnapshot = { clips: state.clips.map((c) => ({ ...c })), telops: state.telops.map((t) => ({ ...t })) };
  const messages: string[] = [];

  if (s.silence) {
    onProgress(0.05, '無音部分を探しています…');
    const before = totalDuration();
    const result = await buildSilenceCutClips(s.silenceOptions);
    if (signal.canceled) throw new Error('中止しました');
    if (result.clips.length > 0) {
      state.clips = result.clips;
      const after = totalDuration();
      messages.push(`無音カット：${formatTime(before)} → ${formatTime(after)}`);
    }
    emitChange();
    onProgress(0.2, '無音カットが終わりました');
  }

  if (s.telop) {
    const segments = await transcribeTimeline({
      model: s.model,
      signal,
      onProgress: (ratio, label) => onProgress(0.2 + ratio * 0.75, label),
    });
    if (signal.canceled) throw new Error('中止しました');
    const telops = segmentsToTelops(segments);
    state.telops = [...state.telops, ...telops];
    messages.push(`テロップ：${telops.length}件を追加`);
    emitChange();
  }

  onProgress(1, '完了');
  return messages.length > 0 ? `完了しました。${messages.join(' / ')}` : '変更はありませんでした';
}
