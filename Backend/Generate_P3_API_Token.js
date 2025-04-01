// generateToken.js
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

// Your Firebase configuration (replace with your actual config)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "p3-auth-762da.firebaseapp.com",
  projectId: "p3-auth-762da",
  storageBucket: "p3-auth-762da.appspot.com",
  messagingSenderId: "1079324928317",
  appId: "YOUR_APP_ID",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Replace with your test user credentials
const email = "scanner01@p3.local";
const password = "Godisgod59145!";

signInWithEmailAndPassword(auth, email, password)
  .then((userCredential) => {
    return userCredential.user.getIdToken();
  })
  .then((idToken) => {
    console.log("DEV_P3_API_TOKEN:", idToken);
  })
  .catch((error) => {
    console.error("Error generating token:", error);
  });
