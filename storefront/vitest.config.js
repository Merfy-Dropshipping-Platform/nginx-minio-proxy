import { defineConfig } from 'vitest/config';

// Быстрые тесты: чистые правила раздачи (njs/route.js) в Node. Тесты с настоящим nginx, MinIO и подставным
// рисовальщиком — test/serve/*.test.js, им нужен стенд `pnpm stack:up`, они идут своей командой (задача 11).
export default defineConfig({
  test: {
    include: ['test/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['njs/route.js'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
