import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const backendUrl =
    mode === "production"
      ? env.VITE_PROD_BACKEND_URL
      : env.VITE_DEV_BACKEND_URL || "http://localhost:8000";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
        "/ws": {
          target: backendUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
