import axios from "axios";

/**
 * Axios factory for P3 backend calls.
 *
 * Base URL resolution:
 *   - Production (Firebase App Hosting): VITE_API_BASE_URL is baked into the
 *     bundle at build time from apphosting.yaml. It points directly at the
 *     Cloud Run backend (e.g. https://p3-backend-....run.app).
 *   - Development: VITE_API_BASE_URL is undefined, so we fall back to "/"
 *     and the Vite dev-server proxy (/api → localhost:8000) handles routing.
 */
export const createApiClient = (idToken) =>
  axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "/",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
