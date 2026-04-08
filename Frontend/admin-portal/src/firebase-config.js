// src/firebase-config.js
import { initializeApp } from "firebase/app";
// import { getAnalytics } from "firebase/analytics"; //Uncomment later for Google Analytics integration
import { getAuth } from "firebase/auth";
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
export const storage = getStorage(app);
