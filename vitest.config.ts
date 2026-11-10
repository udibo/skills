import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});

export default config;
