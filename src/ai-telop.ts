import { clipDuration, sourceOfClip, state, totalDuration } from './state';
import { decodeToAudioBuffer, getDecodeReasons } from './audio-mix';
import { newId, type Telop } from './types';

/** Whisper が受け付けるサンプリングレート。 */
const SPEECH_RATE = 16000;

export type AiModelSize = 'tiny' | 'base' | 'small';

export interface AiModelChoice {
  id: AiModelSize;
  label: string;
  note: string;
  /** モデル候補。先頭から順に試す。 */
  repos: string[];
}

export const AI_MODELS: AiModelChoice[] = [
  {
    id: 'tiny',
    label: '速い（軽い）',
    note: 'ダウンロード約40MB。スマホ向け。精度は控えめ',
    repos: ['onnx-community/whisper-tiny', 'Xenova/whisper-tiny'],
  },
  {
    id: 'base',
    label: '標準（おすすめ）',
    note: 'ダウンロード約80MB。精度と速さのバランスが良い',
    repos: ['onnx-community/whisper-base', 'Xenova/whisper-base'],
  },
  {
    id: 'small',
    label: '高精度（重い）',
    note: 'ダウンロード約250MB。PC向け。時間がかかります',
    repos: ['onnx-community/whisper-small', 'Xenova/whisper-small'],
  },
];

/**
 * AIライブラリ（Transformers.js）は必要になったときだけCDNから読み込む。
 * アプリ本体を軽く保つため、npm の依存には入れていない。
 */
const LIB_URLS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0',
  'https://unpkg.com/@huggingface/transformers@4.3.0',
];

interface TranscriberChunk {
  timestamp: [number, number | null];
  text: string;
}

interface TranscriberResult {
  text: string;
  chunks?: TranscriberChunk[];
}

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<TranscriberResult>;

interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<Transcriber>;
  env: { allowLocalModels?: boolean; backends?: unknown };
}

let libPromise: Promise<TransformersModule> | null = null;

async function loadLibrary(): Promise<TransformersModule> {
  if (libPromise) return libPromise;
  libPromise = (async () => {
    let lastError: unknown = null;
    for (const url of LIB_URLS) {
      try {
        const mod = (await import(/* @vite-ignore */ url)) as TransformersModule;
        if (typeof mod.pipeline === 'function') {
          mod.env.allowLocalModels = false;
          return mod;
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      'AIライブラリを読み込めませんでした。通信環境をご確認のうえ、もう一度お試しください。' +
        (lastError instanceof Error ? `（${lastError.message}）` : ''),
    );
  })();
  try {
    return await libPromise;
  } catch (err) {
    libPromise = null;
    throw err;
  }
}

/** WebGPU が使えるか（使えると数倍速い）。 */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

const transcriberCache = new Map<string, Transcriber>();

async function getTranscriber(
  model: AiModelChoice,
  onProgress: (ratio: number, label: string) => void,
): Promise<Transcriber> {
  const cached = transcriberCache.get(model.id);
  if (cached) return cached;

  const lib = await loadLibrary();
  const device = await pickDevice();
  let lastError: unknown = null;

  for (const repo of model.repos) {
    try {
      const transcriber = await lib.pipeline('automatic-speech-recognition', repo, {
        device,
        dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            onProgress(
              Math.min(0.45, (p.progress / 100) * 0.45),
              `AIモデルを準備しています… ${Math.round(p.progress)}%`,
            );
          } else if (p.status === 'ready') {
            onProgress(0.45, 'AIモデルの準備ができました');
          }
        },
      });
      transcriberCache.set(model.id, transcriber);
      return transcriber;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    'AIモデルを読み込めませんでした。通信環境をご確認ください。' +
      (lastError instanceof Error ? `（${lastError.message}）` : ''),
  );
}

/** 線形補間でサンプリングレートを落とす（Safari の制限を避けるため自前で行う）。 */
function resample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return data;
  const ratio = fromRate / toRate;
  const length = Math.floor(data.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(data.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

/**
 * 編集後のタイムラインの音声を、16kHzモノラルで1本につなげて返す。
 * 認識結果の時刻がそのままタイムライン上の時刻になる。
 */
export async function buildTimelineSpeechAudio(
  onProgress?: (ratio: number, label: string) => void,
): Promise<Float32Array | null> {
  const total = totalDuration();
  if (total <= 0) return null;
  // 中間は 48kHz（Safari でも確実に作れるレート）で組み立て、あとから 16kHz に落とす
  const workRate = 48000;
  const ctx = new OfflineAudioContext(1, Math.ceil(total * workRate), workRate);
  let placed = false;
  let at = 0;
  for (const clip of state.clips) {
    const d = clipDuration(clip);
    if (d <= 0) continue;
    const source = sourceOfClip(clip);
    const buffer = source
      ? await decodeToAudioBuffer(source.blob, { allowRealtime: true, onProgress })
      : null;
    if (buffer) {
      const available = Math.max(0, buffer.duration - clip.start);
      if (available > 0) {
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.start(at, clip.start, Math.min(d, available));
        placed = true;
      }
    }
    at += d;
  }
  if (!placed) return null;
  const rendered = await ctx.startRendering();
  return resample(rendered.getChannelData(0), workRate, SPEECH_RATE);
}

export interface TranscribeOptions {
  model: AiModelChoice;
  onProgress: (ratio: number, label: string) => void;
  signal: { canceled: boolean };
}

export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
}

/** 音声をAIで聞き取り、時刻つきの文に分ける。 */
export async function transcribeTimeline(options: TranscribeOptions): Promise<SpeechSegment[]> {
  const { model, onProgress, signal } = options;
  onProgress(0.02, '音声を準備しています…');
  const audio = await buildTimelineSpeechAudio((r, label) => onProgress(0.02 + r * 0.1, label));
  if (!audio) {
    const reasons = getDecodeReasons();
    throw new Error(
      '音声を取り出せませんでした。音の入っていない動画か、この端末で音声を読み取れない形式の可能性があります。' +
        (reasons.length > 0 ? `（詳細: ${reasons.join(' / ')}）` : ''),
    );
  }
  if (signal.canceled) throw new Error('canceled');

  const transcriber = await getTranscriber(model, onProgress);
  if (signal.canceled) throw new Error('canceled');

  onProgress(0.5, 'AIが音声を聞き取っています…（少し時間がかかります）');
  const result = await transcriber(audio, {
    language: 'japanese',
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const total = totalDuration();
  const chunks = result.chunks ?? [];
  const segments: SpeechSegment[] = [];
  for (const c of chunks) {
    const text = (c.text ?? '').trim();
    if (!text) continue;
    const start = Math.max(0, c.timestamp[0] ?? 0);
    const end = Math.min(total, c.timestamp[1] ?? start + 2);
    if (end - start < 0.2) continue;
    segments.push({ start, end, text });
  }
  if (segments.length === 0 && result.text?.trim()) {
    // 時刻が取れなかったときは、全体を1つのテロップにする
    segments.push({ start: 0, end: Math.min(total, 5), text: result.text.trim() });
  }
  onProgress(1, `聞き取りが終わりました（${segments.length}件）`);
  return segments;
}

/** 長い文を読みやすい長さで折り返す。 */
function wrapForTelop(text: string, perLine = 16, maxLines = 2): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  let rest = clean;
  while (rest.length > 0 && lines.length < maxLines) {
    lines.push(rest.slice(0, perLine));
    rest = rest.slice(perLine);
  }
  if (rest.length > 0 && lines.length > 0) lines[lines.length - 1] += '…';
  return lines.join('\n');
}

/** 聞き取り結果をテロップに変換する。 */
export function segmentsToTelops(segments: SpeechSegment[]): Telop[] {
  return segments.map((s) => ({
    id: newId('telop'),
    text: wrapForTelop(s.text),
    start: s.start,
    end: Math.max(s.start + 0.6, s.end),
    anchor: 'bottom' as const,
    x: 0.5,
    y: 0.86,
    fontSize: 54,
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 5,
    bgEnabled: false,
    bgColor: '#000000',
    bgOpacity: 0.5,
  }));
}
