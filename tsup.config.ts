import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/mcp/server.ts", "src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  // Keep all npm dependencies external (installed at runtime via package.json deps)
  // This avoids bundling issues with CJS/ESM interop (e.g. undici in Anthropic SDK)
  noExternal: [],
  external: [
    "@anthropic-ai/sdk",
    "@google/genai",
    "@modelcontextprotocol/sdk",
    "@playwright/mcp",
    "ws",
    "playwright",
    "freestyle-sandboxes",
    "@freestyle-sh/with-nodejs",
    "undici",
    "posthog-node",
  ],
});
