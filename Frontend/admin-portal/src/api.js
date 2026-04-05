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
 *
 * @param {string} idToken  - Firebase ID token
 * @param {string|null} schoolId - Optional school ID for super_admin context.
 *   When provided, sends X-School-Id header so the backend scopes all queries
 *   to that school.  Pass null (or omit) for platform-level calls.
 */
export const createApiClient = (idToken, schoolId = null) =>
  axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "/",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      ...(schoolId ? { "X-School-Id": schoolId } : {}),
    },
    timeout: 15_000,
  });
