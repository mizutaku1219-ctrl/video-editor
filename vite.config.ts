import { defineConfig } from 'vite';

// GitHub Pages では https://<user>.github.io/<repo>/ で配信するため、
// ビルド時に BASE_PATH を渡してベースURLを切り替える（未指定ならルート）。
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
