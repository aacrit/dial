import { defineConfig } from "vitest/config";
import { voiceTable } from "./scripts/lib/voice-table.mjs";

export default defineConfig({
  plugins: [voiceTable()],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
