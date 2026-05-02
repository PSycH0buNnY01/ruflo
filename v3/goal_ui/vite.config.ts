import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// RuVector + ONNX-WASM packages MUST NOT go through Vite's prebundler —
// they ship .wasm assets that need to load at runtime, not get inlined into
// JS during esbuild's deps optimization. Listed once and reused for both
// the main app and the widget build.
const RUVECTOR_WASM_PKGS = [
  "ruvector",
  "ruvector-onnx-embeddings-wasm",
  "ruvector-attention-wasm",
];

// https://vitejs.dev/config/
export default defineConfig(() => {
  const isWidgetBuild = process.env.BUILD_WIDGET === 'true';

  if (isWidgetBuild) {
    // Widget-specific build configuration
    return {
      plugins: [react()],
      // Treat .wasm files as static assets (copied through, not inlined)
      assetsInclude: ['**/*.wasm'],
      resolve: {
        alias: {
          "@": path.resolve(__dirname, "./src"),
        },
      },
      optimizeDeps: {
        exclude: RUVECTOR_WASM_PKGS,
      },
      define: {
        // Define browser-compatible globals
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env': '{}',
        'global': 'window',
      },
      build: {
        lib: {
          entry: path.resolve(__dirname, "src/widget.tsx"),
          name: "RufloResearchWidget",
          formats: ["iife"],
          fileName: () => "widget.js",
        },
        rollupOptions: {
          output: {
            inlineDynamicImports: true,
            assetFileNames: "widget.[ext]",
            // Ensure all external dependencies are bundled for standalone widget
            manualChunks: undefined,
          },
        },
        // Don't externalize any dependencies - bundle everything
        commonjsOptions: {
          include: [/node_modules/],
        },
        outDir: "dist",
        emptyOutDir: false,
        // Increase chunk size warning limit for widget bundle
        chunkSizeWarningLimit: 1000,
      },
      // CORS configuration for dev server
      server: {
        cors: true,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      },
    };
  }

  // Main app build configuration
  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [react()],
    assetsInclude: ['**/*.wasm'],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    optimizeDeps: {
      exclude: RUVECTOR_WASM_PKGS,
    },
  };
});
