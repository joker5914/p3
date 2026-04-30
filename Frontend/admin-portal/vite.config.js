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
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("/firebase/") || id.includes("/@firebase/")) {
              return "firebase";
            }
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/")
            ) {
              return "react";
            }
            if (id.includes("/react-icons/")) return "react-icons";
            if (id.includes("/axios/")) return "axios";
          },
        },
      },
    },
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
