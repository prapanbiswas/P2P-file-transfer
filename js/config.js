/**
 * PixelDrop — js/config.js
 *
 * ── REQUIRED SETUP ──────────────────────────────────────────────────────
 *  1. Go to https://console.firebase.google.com
 *  2. Create a project (or use existing)
 *  3. Add a Web App to the project
 *  4. Enable Realtime Database in "Build" → "Realtime Database"
 *     → Start in TEST MODE (or apply the rules from README.md)
 *  5. Copy your Firebase SDK snippet values below
 * ────────────────────────────────────────────────────────────────────────
 */
export const FIREBASE_CONFIG = {
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  apiKey: "AIzaSyA3ZnthEJigRSMAU2djqiXtYoQ0R_kZer8",
  authDomain: "p2p-f-t.firebaseapp.com",
  databaseURL: "https://p2p-f-t-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "p2p-f-t",
  storageBucket: "p2p-f-t.firebasestorage.app",
  messagingSenderId: "438209867006",
  appId: "1:438209867006:web:aaf0e460a5ad6ba4cb09af",
  measurementId: "G-SZLRGJB7JF"
};

/**
 * Application-level constants.
 * APP_URL: The canonical URL of your deployed app.
 *          The QR code will encode: APP_URL + "?room=XXXXX"
 *          Defaults to current page URL (works for most deployments).
 */
export const APP_CONFIG = {
  /** Public URL shown in QR code. Override for custom domains. */
  appUrl: (() => {
    const url = new URL(window.location.href);
    url.search = '';          // strip any existing params
    url.hash   = '';
    return url.toString();
  })(),

  /** WebRTC data channel chunk size in bytes BEFORE encryption. */
  chunkSize: 64 * 1024,       // 64 KB

  /** ICE servers — Google STUN + Twilio-free fallback. */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
  ],

  /** Max seconds to wait for ICE gathering before giving up. */
  iceGatherTimeout: 5,

  /** Max seconds to wait for peer before considering room stale. */
  roomTimeout: 1800, // 30 minutes

  /** Show developer log console (set true for debugging). */
  showLog: false,
};
