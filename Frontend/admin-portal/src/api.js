import axios from "axios";
import { auth } from "./firebase-config";

/**
 * Axios factory for Dismissal backend calls.
 *
 * Base URL resolution:
 *   - Production (Firebase App Hosting): VITE_API_BASE_URL is baked into the
 *     bundle at build time from apphosting.yaml. It points directly at the
 *     Cloud Run backend (e.g. https://dismissal-backend-....run.app).
 *   - Development: VITE_API_BASE_URL is undefined, so we fall back to "/"
 *     and the Vite dev-server proxy (/api → localhost:8000) handles routing.
 *
 * @param {string} idToken  - Firebase ID token (used as fallback)
 * @param {string|null} schoolId - Optional school ID for super_admin context.
 *   When provided, sends X-School-Id header so the backend scopes all queries
 *   to that school.  Pass null (or omit) for platform-level calls.
 * @param {string|null} districtId - Optional district ID for super_admin
 *   context when no school is selected but a district is.  Sent as
 *   X-District-Id so the backend can scope district-level views (e.g.
 *   "all schools in this district").
 */
export const createApiClient = (idToken, schoolId = null, districtId = null) => {
  const instance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "/",
    headers: {
      "Content-Type": "application/json",
      ...(schoolId ? { "X-School-Id": schoolId } : {}),
      ...(districtId ? { "X-District-Id": districtId } : {}),
    },
    timeout: 15_000,
  });

  // Request interceptor: resolve a fresh Firebase token before every request.
  // getIdToken() returns the cached token when still valid and silently
  // refreshes it when near expiry, preventing "Invalid or expired token"
  // errors after sleep, backgrounding, or network interruptions.
  instance.interceptors.request.use(async (config) => {
    let token = idToken;
    try {
      token = (await auth.currentUser?.getIdToken()) ?? idToken;
    } catch {
      // Fall back to the token passed at creation time.
    }
    config.headers.Authorization = `Bearer ${token}`;
    return config;
  });

  return instance;
};
