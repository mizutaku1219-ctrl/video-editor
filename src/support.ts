import { canEncodeAudio, canEncodeVideo } from 'mediabunny';

export interface SupportReport {
  secureContext: boolean;
  videoEncoder: boolean;
  videoDecoder: boolean;
  audioEncoder: boolean;
  h264: boolean;
  vp9: boolean;
  aac: boolean;
  opus: boolean;
  /** 映像を書き出せるか（音声なしでも可） */
  canExport: boolean;
  /** 音声付きで書き出せるか */
  canExportAudio: boolean;
  messages: string[];
}

/** 起動時に WebCodecs まわりの対応状況を調べる。 */
export async function checkSupport(): Promise<SupportReport> {
  const secureContext = window.isSecureContext;
  const videoEncoder = typeof window.VideoEncoder === 'function';
  const videoDecoder = typeof window.VideoDecoder === 'function';
  const audioEncoder = typeof window.AudioEncoder === 'function';

  let h264 = false;
  let vp9 = false;
  let aac = false;
  let opus = false;
  if (videoEncoder) {
    try {
      h264 = await canEncodeVideo('avc', { width: 1280, height: 720 });
    } catch {
      h264 = false;
    }
    try {
      vp9 = await canEncodeVideo('vp9', { width: 1280, height: 720 });
    } catch {
      vp9 = false;
    }
  }
  if (audioEncoder) {
    try {
      aac = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 });
    } catch {
      aac = false;
    }
    try {
      opus = await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 });
    } catch {
      opus = false;
    }
  }

  const messages: string[] = [];
  if (!secureContext) {
    messages.push(
      'HTTPS でないため WebCodecs が使えません。GitHub Pages など https:// のURLで開いてください（localhost は例外的に動きます）。',
    );
  }
  if (!videoEncoder || !videoDecoder) {
    messages.push(
      'この端末・ブラウザは WebCodecs に対応していません。iPhone は Safari（iOS 16 以降）、Android は Chrome、PC は Chrome / Edge をお試しください。',
    );
  } else if (!h264 && vp9) {
    messages.push(
      'H.264 の書き出しに対応していない環境のため、VP9 で MP4 を作ります。iPhone など一部の端末では再生できないことがあります。',
    );
  } else if (!h264 && !vp9) {
    messages.push('このブラウザでは映像を書き出せません。Chrome / Edge / Safari をお試しください。');
  }
  if (!aac && opus) {
    messages.push(
      '音声（AAC）の書き出しに対応していない環境です（Firefox など）。代わりに Opus 音声で書き出しますが、iPhone など一部の端末では音が出ないことがあります。確実に再生したい場合は Chrome / Edge / Safari をお使いください。',
    );
  } else if (!aac && !opus) {
    messages.push(
      '音声の書き出しに対応していない環境です。映像とテロップだけの無音MP4として書き出します。音を残したい場合は Chrome / Edge / Safari をお使いください。',
    );
  }

  return {
    secureContext,
    videoEncoder,
    videoDecoder,
    audioEncoder,
    h264,
    vp9,
    aac,
    opus,
    canExport: secureContext && videoEncoder && videoDecoder && (h264 || vp9),
    canExportAudio: aac || opus,
    messages,
  };
}
