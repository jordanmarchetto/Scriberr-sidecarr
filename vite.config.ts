import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "ui",
  base: "/__SIDECARR_ASSET_BASE__/",
  plugins: [react()],
  build: {
    outDir: "../ui-dist",
    emptyOutDir: true
  }
});
