import { decodeAudio, getDecodeReasons } from './audio-decode';
import { AI_MODELS, buildTimelineSpeechAudio, getLoadedLibUrl, transcribeTimeline } from './ai-telop';
import { state } from './state';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 端末で「おまかせ編集」が動くかを順番に確かめる。
 * どこで失敗しているかを利用者が画面で確認できるようにするための機能。
 */
export async function runDiagnostics(
  onStep: (result: CheckResult) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const push = (r: CheckResult): void => {
    results.push(r);
    onStep(r);
  };

  // 1. 基本機能
  push({
    name: '安全な接続（HTTPS）',
    ok: window.isSecureContext,
    detail: window.isSecureContext ? 'OK' : 'https:// で開いてください',
  });
  push({
    name: 'WebCodecs（動画の書き出し）',
    ok: typeof window.VideoEncoder === 'function',
    detail: typeof window.VideoEncoder === 'function' ? 'OK' : '非対応',
  });
  push({
    name: '音声デコーダー（AudioDecoder）',
    ok: typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder === 'function',
    detail:
      typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder === 'function'
        ? 'OK'
        : '非対応（別の方法で代替します）',
  });
  const hasGpu = 'gpu' in navigator;
  push({ name: 'WebGPU（AIの高速化）', ok: hasGpu, detail: hasGpu ? '使えます' : 'なし（遅くなります）' });

  // 2. 動画から音を取り出せるか
  if (state.sources.length === 0) {
    push({ name: '動画の音声', ok: false, detail: '動画が読み込まれていません' });
  } else {
    const source = state.sources[0];
    const t0 = performance.now();
    const buffer = await decodeAudio(source.blob, { allowRealtime: false });
    const ms = Math.round(performance.now() - t0);
    if (buffer) {
      let peak = 0;
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < ch.length; i += 64) peak = Math.max(peak, Math.abs(ch[i]));
      push({
        name: '動画の音声を取り出す',
        ok: peak > 0.0005,
        detail:
          peak > 0.0005
            ? `OK（${ms}ms、音の大きさ ${(peak * 100).toFixed(1)}%）`
            : '音が入っていないようです（無音の動画？）',
      });
    } else {
      push({
        name: '動画の音声を取り出す',
        ok: false,
        detail: `失敗：${getDecodeReasons().join(' / ') || '理由不明'}（実行時は再生取り込みで代替します）`,
      });
    }
  }

  // 3. AIライブラリ
  let libOk = false;
  try {
    const audio = new Float32Array(16000); // 1秒の無音
    await transcribeTimelineProbe(audio);
    libOk = true;
    push({ name: 'AIライブラリの読み込み', ok: true, detail: getLoadedLibUrl() ?? 'OK' });
  } catch (err) {
    push({
      name: 'AIライブラリの読み込み',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (libOk) {
    push({
      name: 'AIモデルの読み込み',
      ok: true,
      detail: `${AI_MODELS[0].label} で確認しました`,
    });
  }

  return results;
}

/** ごく短い音声で、ライブラリとモデルが動くかだけ確かめる。 */
async function transcribeTimelineProbe(audio: Float32Array): Promise<void> {
  const { probeAi } = await import('./ai-telop');
  await probeAi(audio);
}

export { buildTimelineSpeechAudio, transcribeTimeline };
