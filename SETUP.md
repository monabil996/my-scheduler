# My Scheduler — Setup Guide

## What you need (all free)

1. **Google account** — for Firebase and sign-in
2. **Gemini API key** — for AI summaries
3. **Vercel account** — for hosting (optional, but the easiest way to go live)

---

## Step 1 — Get your Gemini API key

1. Go to [https://aistudio.google.com](https://aistudio.google.com)
2. Click **Get API key** → **Create API key**
3. Copy the key (starts with `AIza…`)

---

## Step 2 — Create a Firebase project

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → name it (e.g. `my-scheduler`) → Continue
3. Disable Google Analytics if you don't need it → **Create project**

### Enable Google Sign-In
4. In the left menu: **Build → Authentication → Get started**
5. Click **Google** → Enable → Save

### Create Firestore database
6. **Build → Firestore Database → Create database**
7. Choose **Start in test mode** → select a region near you → Enable

### Get your Firebase config
8. **Project settings** (gear icon) → **Your apps** → click `</>` (Web)
9. Register app with a nickname → copy the `firebaseConfig` values

---

## Step 3 — Create your .env file

In the project folder, copy `.env.example` to `.env` and fill in:

```
VITE_GEMINI_API_KEY=your-gemini-key
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

---

## Step 4 — Run locally to test

Open a terminal in this folder and run:

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) — you should see the Google sign-in screen.

---

## Step 5 — Deploy to Vercel (go live online)

1. Go to [https://vercel.com](https://vercel.com) → sign up with GitHub
2. Push this project to a GitHub repo
3. In Vercel: **Add New Project** → import your repo
4. **Before deploying**, go to **Settings → Environment Variables** and add all 7 variables from your `.env` file
5. Click **Deploy** — Vercel gives you a public URL instantly

### Add your Vercel URL to Firebase (important!)
6. Firebase Console → **Authentication → Settings → Authorized domains**
7. Add your Vercel URL (e.g. `my-scheduler.vercel.app`)

---

## Use it on mobile

Once deployed, open your Vercel URL on your phone in Chrome/Safari.
- **Android**: tap the 3-dot menu → "Add to Home screen"
- **iPhone**: tap the Share button → "Add to Home Screen"

It works like an installed app!

---

## Firestore security (before going public)

Once you're done testing, update Firestore rules so only you can read your data:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Paste this in: Firebase Console → Firestore → **Rules** → Publish.
