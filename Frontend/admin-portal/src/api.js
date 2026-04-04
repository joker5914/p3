import axios from "axios";

/**
 * Axios factory for P3 backend calls.
 * Uses a relative base URL so the Vite proxy handles routing in dev,
 * and the same origin works in production. No hardcoded host.
 */
export const createApiClient = (idToken) =>
  axios.create({
    baseURL: "/",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
