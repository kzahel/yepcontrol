import { defineConfig } from "vite";
export default defineConfig({
  build: {
    rollupOptions: { input: ["index.html", "viewer.html", "install.html"] },
  },
});
