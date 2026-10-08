import { defineConfig } from 'vitest/config';

// Тесты раздачи целиком: настоящий nginx с njs, MinIO и подставной рисовальщик стенда compose.test.yml. Перед ними —
// `pnpm stack:up`. Файлы идут по одному: тесты считают вызовы рисовальщика, а он у стенда один на всех.
export default defineConfig({
  test: {
    include: ['test/serve/*.test.js'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
