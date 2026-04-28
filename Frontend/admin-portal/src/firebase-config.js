// src/firebase-config.js
import { initializeApp } from "firebase/app";
// import { getAnalytics } from "firebase/analytics"; //Uncomment later for Google Analytics integration
import { getAuth, GoogleAuthProvider, OAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: "AIzaSyAptP2cM_xj764rrwC4FRnbmnQJwFsLvFM",
    authDomain: "p3-auth-762da.firebaseapp.com",
    projectId: "p3-auth-762da",
    storageBucket: "p3-auth-762da.firebasestorage.app",
    messagingSenderId: "1079324928317",
    appId: "1:1079324928317:web:b554f43a8a42ea3bbe3d54",
    measurementId: "G-8KG5C0D6EL"
  };

const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app); //Uncomment later for Google Analytics integration
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ── Federated sign-in providers (see issue #88) ─────────────────────────────
// Construction is inexpensive — we export factory functions rather than
// singletons so callers can tweak custom parameters (e.g. Microsoft tenant,
// Google hosted domain) per sign-in attempt without mutating shared state.
export function googleProvider() {
  const p = new GoogleAuthProvider();
  // Force account chooser instead of silently reusing the last session —
  // matters on shared staff devices.
  p.setCustomParameters({ prompt: "select_account" });
  return p;
}

export function microsoftProvider({ tenant } = {}) {
  // OIDC provider ID "microsoft.com" is the one Firebase Auth registers
  // when you enable the Microsoft provider in the Firebase console.
  const p = new OAuthProvider("microsoft.com");
  p.setCustomParameters({
    prompt: "select_account",
    // Empty/unset tenant => "common" endpoint (any Microsoft account).
    // A district that restricts to a specific Entra tenant passes its
    // tenant id via the SSO config.
    ...(tenant ? { tenant } : {}),
  });
  return p;
}
