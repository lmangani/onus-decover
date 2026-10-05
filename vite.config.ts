import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const ORT_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

function copyOrtAssets(): Plugin {
  const copy = () => {
    const source = dirname(require.resolve("onnxruntime-web"));
    const dest = join(root, "public/ort");
    mkdirSync(dest, { recursive: true });
    for (const name of ORT_FILES) cpSync(join(source, name), join(dest, name));
  };
  return {
    name: "copy-ort",
    configResolved: copy,
    buildStart: copy,
  };
}

export default defineConfig({
  // Project Pages live at /onus-tools/. Local dev and preview stay at /.
  base: process.env.GITHUB_PAGES === "true" ? "/onus-tools/" : "/",
  plugins: [copyOrtAssets()],
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
