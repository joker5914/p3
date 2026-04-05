/**
 * Minimal production server for the P3 admin portal.
 *
 * Firebase App Hosting builds the Vite SPA (producing dist/) then runs this
 * server inside a Cloud Run container listening on $PORT. Express serves the
 * static assets and falls back to index.html for all routes so React's
 * client-side view-switching works after a hard refresh.
 */
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const DIST = join(__dirname, "dist");

// Serve pre-built static assets with sensible cache headers
app.use(
  express.static(DIST, {
    // Hashed filenames (JS/CSS chunks) can be cached aggressively;
    // index.html itself is never cached so updates reach users immediately.
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

// SPA fallback — unknown paths serve index.html; React handles routing.
app.get("*", (_req, res) => {
  res.sendFile(join(DIST, "index.html"));
});

app.listen(PORT, () => {
  console.log(`P3 admin portal listening on port ${PORT}`);
});
