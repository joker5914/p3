// generateToken.js
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

// Your Firebase configuration (replace with your actual config)
const firebaseConfig = {
  apiKey: "AIzaSyCzckS2MVjMby8dvKDE8wtIWzM2XewvnUg",
  authDomain: "dismissal-cloud.firebaseapp.com",
  projectId: "dismissal-cloud",
  storageBucket: "dismissal-cloud.firebasestorage.app",
  messagingSenderId: "177955649483",
  appId: "1:177955649483:web:fc42c84772055e9989284e",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Replace with your test user credentials
const email = "scanner01@dismissal.local";
const password = "Godisgod59145!";

signInWithEmailAndPassword(auth, email, password)
  .then((userCredential) => {
    return userCredential.user.getIdToken();
  })
  .then((idToken) => {
    console.log("DEV_DISMISSAL_API_TOKEN:", idToken);
  })
  .catch((error) => {
    console.error("Error generating token:", error);
  });
