import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // testes de taxa/latência medem tempo real: não rodar arquivos em paralelo
    fileParallelism: false,
  },
});
