import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/feature",
    emptyOutDir: false,
    lib: {
      entry: "src/web/feature.ts",
      formats: ["es"],
      fileName: "feature",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: { entryFileNames: "[name].js", banner: '"use client";' },
    },
  },
});
