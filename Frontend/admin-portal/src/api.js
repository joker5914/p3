import axios from "axios";

// Log the environment variables for debugging
console.log("import.meta.env:", import.meta.env);

const BASE_URL = "http://localhost:8000";  // Temporarily hardcode
// const BASE_URL = import.meta.env.DEV
//   ? import.meta.env.VITE_DEV_BACKEND_URL
//   : import.meta.env.VITE_PROD_BACKEND_URL;

console.log("Using BASE_URL:", BASE_URL);

export const createApiClient = (idToken) => {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${idToken}`
    }
  });
};