import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5317,
    strictPort: true,
    host: "127.0.0.1",
    // ws: the Android tab streams the emulator screen over a WebSocket.
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true, ws: true } },
  },
});
