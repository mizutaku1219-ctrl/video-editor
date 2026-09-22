# かんたん動画編集（ブラウザ完結の動画編集Webアプリ）

スマホ（iPhone Safari / Android Chrome）とPC（Chrome / Edge）で、短い動画（〜3分程度）に
**カット・テロップ・BGM** を付けて **MP4** で保存できます。

- サーバー処理なし・有料APIなし・ログインなし
- 動画は**すべて端末の中**で処理され、どこにもアップロードされません
- 編集中のプロジェクトは端末内（IndexedDB）に自動保存されます

公開URL（GitHub Pages）: `https://<ユーザー名>.github.io/video-editor/`

## 機能

1. **読み込み・プレビュー** — 動画ファイル選択、再生/一時停止、シークバー
2. **カット編集** — 再生位置で分割、開始/終了のトリミング、不要クリップの削除、並べ替え・連結
3. **テロップ** — 文字入力、表示開始/終了時間、位置（上・中央・下＋ドラッグ）、文字サイズ、文字色、縁取り、背景帯（日本語フォントは Noto Sans JP）
4. **BGM** — 端末内の音楽ファイル（mp3 / m4a / wav）を追加、BGMと元動画の音量を個別調整、フェードイン/アウト、ループ
5. **書き出し** — canvas に映像＋テロップを描画 → `VideoEncoder`（H.264）、音声は `AudioEncoder`（AAC）→ Mediabunny で MP4 化。進捗バー付き、完了後にダウンロード（iPhone は共有シートから写真アプリへ保存）

## 技術構成

- Vite + TypeScript（フレームワークなし）
- 動画の読み込み・書き出し：**WebCodecs + [Mediabunny](https://github.com/Vanilagy/mediabunny)**
- **ffmpeg.wasm は使っていません**（iPhone 非対応・特殊なCOOP/COEPヘッダーが必要なため）
- 音声の合成：Web Audio API（`OfflineAudioContext`）
- 保存：IndexedDB
- 公開：GitHub Pages（GitHub Actions で自動デプロイ）

## PCでの起動方法

```bash
npm install
npm run dev        # http://localhost:5173/ が開けます
```

ビルドと確認：

```bash
npm run build      # 型チェック + 本番ビルド（dist/）
npm run preview
```

> WebCodecs は **HTTPS 必須**です。`localhost` は例外的に動きますが、
> スマホでの動作確認は必ず GitHub Pages（https://）で行ってください。

## GitHub Pages での公開手順

1. このリポジトリを GitHub に push します。
2. GitHub の **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。
3. `main` ブランチに push すると `.github/workflows/deploy.yml` が動き、自動で公開されます。
4. Actions タブでデプロイ完了を確認したら、次のURLを開きます。

   ```
   https://<ユーザー名>.github.io/video-editor/
   ```

### スマホでの確認手順

1. 上のURLをスマホの Safari（iPhone）/ Chrome（Android）で開きます。
   - QRコードにするか、自分宛てにURLを送ると楽です。
2. 画面上部に赤やオレンジの案内が出ていないか確認します（対応状況のチェック結果です）。
3. 「動画を選ぶ」→ 端末内の短い動画を選択します。
4. カット・テロップ・BGM を編集して「書き出し」タブへ。
5. 「MP4を書き出す」→ 完了後、
   - **iPhone**：「共有」ボタン →「ビデオを保存」で写真アプリに入ります。
   - **Android / PC**：「保存（ダウンロード）」でそのまま保存できます。

## 対応状況と制限

| 環境 | 映像(H.264) | 音声(AAC) | 備考 |
| --- | --- | --- | --- |
| iPhone Safari（iOS 16以降） | ○ | ○ | HTTPS必須。ユーザー操作後に再生が始まります |
| Android Chrome | ○ | ○ | |
| PC Chrome / Edge | ○ | ○ | |
| Firefox | ✕（VP9で代替） | ✕（Opusで代替） | MP4は作れますが端末によっては再生できません |

- 起動時に WebCodecs / AudioEncoder の対応状況を自動チェックし、非対応の場合は画面上部に日本語で案内します。
- H.264 が使えない環境では VP9、AAC が使えない環境では Opus にフォールバックします（その旨を画面に表示します）。
- 長い動画・大きいファイルでメモリ不足にならないよう、デコードしたフレームは使い終わったら必ず `close()` しています。それでも端末の性能差が大きいので、**3分程度まで**の動画をおすすめします。

## 音楽について

- 権利トラブル防止のため、**音源ファイルはアプリに同梱していません**。
- フリーBGMは各サイトの利用規約を確認して使ってください（アプリ画面にも常時表示しています）。

## ディレクトリ

```
index.html            画面の骨組み
src/
  main.ts             起動・画面の組み立て・タブ切り替え
  state.ts            プロジェクトの状態とタイムライン計算
  db.ts               IndexedDB への保存・復元
  support.ts          WebCodecs / AudioEncoder の対応チェック
  player.ts           プレビュー再生エンジン
  render.ts           canvas への映像＋テロップ描画（プレビューと書き出しで共通）
  timeline-ui.ts      タイムライン（クリップ一覧）
  panel-cut.ts        カット編集
  panel-telop.ts      テロップ編集
  panel-bgm.ts        BGM・音量
  panel-export.ts     書き出しUI
  export.ts           MP4書き出し処理
  audio-mix.ts        音声デコードとミックス（OfflineAudioContext）
```
