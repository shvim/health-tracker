# Health Tracker

Netlify-ready Vite app with Firebase persistence.

## Deploy

1. In Netlify, upload this folder or connect it as the site base directory.
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Add the `VITE_FIREBASE_*` environment variables from `.env.example`.

This build signs in anonymously and stores entries at:

`users/{anonymousUserId}/healthTracker/health-tracker-v3`

If Firebase config is missing, the app falls back to browser `localStorage`.

## Firebase

Enable Firebase Authentication with the Anonymous provider, enable Firestore, then deploy or paste the rules in `firestore.rules`.
