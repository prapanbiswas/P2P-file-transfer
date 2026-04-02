# PIXELDROP 🔒
### Secure Peer-to-Peer File Transfer — AES-256-GCM + WebRTC

A fully client-side, encrypted P2P file transfer app with an 8-bit pixel art UI.
Files are encrypted **on your device** before leaving — no server ever sees your data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  SENDER                        RECEIVER                          │
│  ──────                        ────────                          │
│  1. Generate ECDH keypair      1. Scan QR / enter code           │
│  2. Create WebRTC offer        2. Generate ECDH keypair          │
│  3. Publish to Firebase ──────▶ 3. Fetch offer from Firebase     │
│                                 4. Derive shared AES key (ECDH)  │
│  5. Derive shared AES key ◀─── 5. Publish answer to Firebase     │
│  6. Set remote answer          6. WebRTC P2P established         │
│  7. P2P channel open           7. Send READY signal              │
│                                                                   │
│  ── Firebase signaling ends here — all data is now P2P ──        │
│                                                                   │
│  8. Encrypt chunk w/ AES-GCM ──────────────▶ 9. Decrypt chunk   │
│     (unique IV per chunk)          (verify GCM auth tag)         │
│  10. Repeat for all chunks     11. Assemble Blob, offer download  │
└─────────────────────────────────────────────────────────────────┘
```

### Security Model
- **ECDH P-256**: Ephemeral key pairs are generated fresh each session. The shared AES key is derived from Diffie-Hellman — the key itself is never transmitted.
- **AES-256-GCM**: Every 64 KB chunk is encrypted with a unique random 96-bit IV. The 128-bit GCM authentication tag prevents tampering.
- **Firebase only sees**: Encrypted SDP blobs and ECDH *public* keys. No file data or symmetric keys ever pass through Firebase.
- **WebRTC DTLS**: The P2P channel is additionally secured by DTLS, giving you double-layer encryption.

---

## Firebase Setup (Required)

PixelDrop uses Firebase Realtime Database **only for WebRTC signaling** (exchanging SDP and public keys). After the P2P connection is established, Firebase is no longer involved.

### Steps

1. **Create a Firebase project**
   - Go to [console.firebase.google.com](https://console.firebase.google.com)
   - Click "Add project" → name it → disable Google Analytics (optional) → Create

2. **Add a Web App**
   - Project Overview → click `</>` Web icon → Register app → name it
   - Copy the `firebaseConfig` object values

3. **Enable Realtime Database**
   - Build → Realtime Database → Create Database
   - Choose your region → Start in **test mode** (or use the rules below)
   - Copy the `databaseURL` from the Database page

4. **Paste config into `js/config.js`**
   ```javascript
   export const FIREBASE_CONFIG = {
     apiKey:            "AIza...",
     authDomain:        "your-app.firebaseapp.com",
     databaseURL:       "https://your-app-default-rtdb.firebaseio.com",
     projectId:         "your-app",
     storageBucket:     "your-app.appspot.com",
     messagingSenderId: "123456789",
     appId:             "1:123...",
   };
   ```

5. **Set Database Security Rules**
   In Firebase Console → Realtime Database → Rules tab:
   ```json
   {
     "rules": {
       "rooms": {
         "$roomCode": {
           ".read":  true,
           ".write": true,
           ".indexOn": ["createdAt"],
           "offer":            { ".validate": "newData.hasChildren(['sdp', 'type'])" },
           "senderPublicKey":  { ".validate": "newData.isString()" },
           "answer":           { ".validate": "newData.hasChildren(['sdp', 'type', 'receiverPublicKey'])" },
           "createdAt":        { ".validate": "newData.isNumber()" }
         }
       }
     }
   }
   ```
   > These rules allow public read/write but validate structure. For production, add rate-limiting or authentication.

---

## Deployment (GitHub Pages)

1. Push the `pixeldrop/` folder to a GitHub repository
2. Settings → Pages → Source: `Deploy from branch` → `main` → `/root`
3. Your app URL will be: `https://yourusername.github.io/pixeldrop/`
4. Update `APP_CONFIG.appUrl` in `js/config.js` if needed (it auto-detects by default)

---

## How the 3 Connection Methods Work

### Method A — URL Parameter (QR Scan with phone camera)
The QR code encodes: `https://yourdomain.com/pixeldrop/?room=XXXXX`

When the receiver scans with their native phone camera and taps the link, the browser opens the page with `?room=XXXXX`. The app detects this parameter on startup and **automatically** begins the connection process.

**Code location**: `js/app.js` → `init()` → URL param detection

### Method B — In-App QR Scanner
Click "SCAN QR" tab → "START CAMERA". Uses the `html5-qrcode` library to access the device camera via `getUserMedia()`. Decodes the QR, extracts the URL/code, and connects.

**Code location**: `js/app.js` → `startScanner()` / `extractCode()`

### Method C — Manual Code Entry
Type the 5-character alphanumeric code into the input box and click CONNECT. Works on any desktop.

**Code location**: `js/app.js` → `initReceiverConnect()` → manual entry handler

---

## File Structure

```
pixeldrop/
├── index.html                 — Single-page app shell, all screens
├── css/
│   └── style.css              — 8-bit pixel art UI (Press Start 2P font)
├── js/
│   ├── config.js              — ⚠ EDIT THIS: Firebase config + app constants
│   ├── crypto-engine.js       — ECDH key exchange + AES-256-GCM encryption
│   ├── signaling.js           — Firebase Realtime Database signaling
│   ├── webrtc-manager.js      — RTCPeerConnection + RTCDataChannel management
│   └── app.js                 — Main state machine, UI, transfer logic
└── README.md
```

---

## Third-Party Libraries (CDN, no npm needed)

| Library | Purpose | CDN |
|---------|---------|-----|
| `qrcodejs` v1.0.0 | QR code generation | cdnjs.cloudflare.com |
| `html5-qrcode` v2.3.8 | In-app camera QR scanner | unpkg.com |
| Firebase v10.12.0 | Realtime Database signaling | gstatic.com |
| Press Start 2P | Pixel art font | Google Fonts |

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebRTC DataChannel | ✅ | ✅ | ✅ 15.1+ | ✅ |
| Web Crypto API | ✅ | ✅ | ✅ | ✅ |
| ES Modules | ✅ | ✅ | ✅ | ✅ |
| Camera (QR scan) | ✅ | ✅ | ✅ | ✅ |

> **HTTPS required** for WebRTC and camera access. GitHub Pages serves HTTPS automatically.

---

## Debugging

Set `showLog: true` in `js/config.js → APP_CONFIG` to show the on-screen log console.

Common issues:
- **"Room not found"**: The sender may not have published the offer yet, or the code is wrong.
- **ICE connection failed**: Both peers may be behind strict NATs. Consider adding a TURN server to `APP_CONFIG.iceServers`.
- **Camera denied**: HTTPS is required for `getUserMedia`. Ensure you're on `https://`.

---

## Adding a TURN Server (for stricter NATs)

If connections fail between networks (especially mobile → desktop), add a TURN server:
```javascript
// In js/config.js → APP_CONFIG.iceServers
{ urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' }
```
Free TURN: [Metered](https://www.metered.ca/tools/openrelay/) offers free relay servers.

---

*Built with ❤ and 8-bit pixels. No cloud storage. No analytics. No ads.*
