import axios from "axios";
import { auth } from "./firebase-config";

/**
 * Axios factory for Dismissal backend calls. The portal is served from
 * Firebase Hosting and Hosting rewrites /api/** to the `api` Cloud Function,
 * so all calls are same-origin in production. In dev the Vite proxy
 * (/api → localhost:8000) handles routing.
 */
export const createApiClient = (idToken, schoolId = null, districtId = null) => {
  const instance = axios.create({
    baseURL: "/",
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
