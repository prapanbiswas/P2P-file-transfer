/**
 * PixelDrop — js/app.js
 *
 * Main application controller.
 * Coordinates: UI state machine · CryptoEngine · SignalingManager · WebRTCManager
 * Handles: Sender flow · Receiver flow (3 methods) · File transfer · QR code
 */

import { FIREBASE_CONFIG, APP_CONFIG } from './config.js';
import { CryptoEngine }                 from './crypto-engine.js';
import { SignalingManager }             from './signaling.js';
import { WebRTCManager }                from './webrtc-manager.js';

// ─────────────────────────────────────────────────────────────────────────────
// DETECT FIREBASE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const FIREBASE_CONFIGURED = !FIREBASE_CONFIG.apiKey.includes('YOUR_');

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL SESSION STATE
// ─────────────────────────────────────────────────────────────────────────────

/** All mutable session state lives here, reset on each new session. */
let S = createEmptyState();

function createEmptyState() {
  return {
    role:           null,   // 'sender' | 'receiver'
    roomCode:       null,
    file:           null,   // File object (sender)
    crypto:         null,   // CryptoEngine
    signaling:      null,   // SignalingManager
    webrtc:         null,   // WebRTCManager
    startTime:      null,   // transfer start timestamp
    // Transfer progress
    totalChunks:    0,
    sentChunks:     0,
    receivedChunks: new Map(),
    fileInfo:       null,   // { name, size, mime, chunks, chunkSize }
    downloadUrl:    null,
    // Scanner
    qrScanner:      null,
    scannerRunning: false,
    // Signaling unsubscriber
    answerUnsub:    null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────────────────────────────────────

const logEl  = document.getElementById('log-output');

function log(msg, type = 'info') {
  const time    = new Date().toLocaleTimeString('en-US', { hour12: false });
  const classes = { info: 'log-line-info', ok: 'log-line-ok', err: 'log-line-err' };
  const div     = document.createElement('div');
  div.className = classes[type] ?? '';
  div.textContent = `[${time}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  if (type === 'err') console.error('[PixelDrop]', msg);
  else console.log('[PixelDrop]', msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

const SCREENS = [
  'home', 'sender-select', 'sender-room', 'sender-transfer', 'sender-done',
  'receiver-connect', 'receiver-connecting', 'receiver-transfer', 'receiver-done', 'error'
];

function showScreen(id) {
  for (const s of SCREENS) {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('active', s === id);
  }
  log(`Screen: ${id}`);
}

function showBackButton(show = true) {
  document.getElementById('btn-back').classList.toggle('hidden', !show);
}

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  showScreen('error');
  showBackButton(true);
  log(msg, 'err');
}

// ─────────────────────────────────────────────────────────────────────────────
// HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('btn-send-mode').addEventListener('click', () => {
  if (!FIREBASE_CONFIGURED) { showFirebaseOverlay(); return; }
  S = createEmptyState();
  S.role = 'sender';
  showScreen('sender-select');
  showBackButton(true);
});

document.getElementById('btn-receive-mode').addEventListener('click', () => {
  if (!FIREBASE_CONFIGURED) { showFirebaseOverlay(); return; }
  S = createEmptyState();
  S.role = 'receiver';
  initReceiverConnect(null);
});

document.getElementById('btn-back').addEventListener('click', () => {
  stopScanner();
  cleanupSession();
  showScreen('home');
  showBackButton(false);
});

document.getElementById('btn-error-home').addEventListener('click', () => {
  cleanupSession();
  showScreen('home');
  showBackButton(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// FILE DROP ZONE (SENDER)
// ─────────────────────────────────────────────────────────────────────────────

const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelected(fileInput.files[0]);
});

function handleFileSelected(file) {
  S.file = file;
  document.getElementById('selected-file-name').textContent = file.name;
  document.getElementById('selected-file-size').textContent = CryptoEngine.formatBytes(file.size);
  document.getElementById('selected-file-info').classList.remove('hidden');
  log(`File selected: ${file.name} (${CryptoEngine.formatBytes(file.size)})`, 'ok');
}

document.getElementById('btn-create-room').addEventListener('click', async () => {
  if (!S.file) return;
  await startSenderSession();
});

// ─────────────────────────────────────────────────────────────────────────────
// SENDER SESSION
// ─────────────────────────────────────────────────────────────────────────────

async function startSenderSession() {
  try {
    // 1. Init crypto engine
    S.crypto    = new CryptoEngine();
    await S.crypto.init();
    log('ECDH key pair generated', 'ok');

    // 2. Init WebRTC — create offer
    S.webrtc = new WebRTCManager(APP_CONFIG.iceServers, APP_CONFIG.iceGatherTimeout, {
      onOpen:    () => onSenderPeerConnected(),
      onClose:   () => log('Peer connection closed'),
      onMessage: (data) => onSenderMessage(data),
      onError:   (e) => log('DataChannel error: ' + e.message, 'err'),
    });

    log('Creating WebRTC offer...');
    const offerSdp = await S.webrtc.createOffer();
    log('Offer created (ICE gathered)', 'ok');

    // 3. Init signaling
    S.signaling = new SignalingManager(FIREBASE_CONFIG);
    S.roomCode  = S.signaling.generateCode();
    log(`Room code: ${S.roomCode}`, 'ok');

    // 4. Export public key and publish offer to Firebase
    const senderPubKey = await S.crypto.exportPublicKey();
    await S.signaling.publishOffer(S.roomCode, offerSdp, senderPubKey);
    log('Offer published to Firebase', 'ok');

    // 5. Show the room code + QR UI
    showSenderRoom();

    // 6. Listen for receiver's answer
    S.answerUnsub = S.signaling.onAnswer(S.roomCode, async ({ answerSdp, receiverPubKeyJwk }) => {
      if (S.answerUnsub) { S.answerUnsub(); S.answerUnsub = null; }
      log('Answer received from Firebase', 'ok');
      try {
        await S.webrtc.setRemoteAnswer(answerSdp);
        await S.crypto.deriveSharedKey(receiverPubKeyJwk);
        log('AES-256-GCM shared key derived (ECDH)', 'ok');
      } catch (err) {
        showError('Key exchange failed: ' + err.message);
      }
    });

  } catch (err) {
    showError('Failed to start session: ' + err.message);
  }
}

function showSenderRoom() {
  // Render room code chars
  const codeEl = document.getElementById('room-code-display');
  codeEl.innerHTML = '';
  for (const ch of S.roomCode) {
    const span = document.createElement('span');
    span.className = 'code-char';
    span.textContent = ch;
    codeEl.appendChild(span);
  }

  // Generate QR code
  const qrUrl  = `${APP_CONFIG.appUrl}?room=${S.roomCode}`;
  const qrEl   = document.getElementById('qr-code-canvas');
  qrEl.innerHTML = '';
  // QRCode is loaded as a global from CDN
  try {
    new QRCode(qrEl, {
      text:          qrUrl,
      width:         200,
      height:        200,
      colorDark:     '#000000',
      colorLight:    '#ffffff',
      correctLevel:  QRCode.CorrectLevel.M,
    });
  } catch (e) {
    log('QR generation failed: ' + e.message, 'err');
  }

  document.getElementById('qr-url-display').textContent = qrUrl;

  // Copy code button
  document.getElementById('btn-copy-code').onclick = () => {
    navigator.clipboard.writeText(S.roomCode).catch(() => {});
    document.getElementById('btn-copy-code').textContent = '✓ COPIED';
    setTimeout(() => {
      document.getElementById('btn-copy-code').textContent = '⎘ COPY CODE';
    }, 2000);
  };

  showScreen('sender-room');
  showBackButton(true);
  log('Sender room UI ready', 'ok');
}

function onSenderPeerConnected() {
  log('WebRTC peer connected!', 'ok');
  document.getElementById('waiting-indicator').classList.add('hidden');
  document.getElementById('connected-indicator').classList.remove('hidden');

  // Give the data channel a moment to settle, then start transfer
  setTimeout(() => startFileTransfer(), 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDER MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

function onSenderMessage(data) {
  if (typeof data !== 'string') return;
  try {
    const msg = JSON.parse(data);
    if (msg.t === 'READY') {
      log('Receiver sent READY', 'ok');
      // Already starting via onSenderPeerConnected, but handle if delayed
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE TRANSFER (SENDER → RECEIVER)
// ─────────────────────────────────────────────────────────────────────────────

async function startFileTransfer() {
  const file      = S.file;
  const chunkSize = APP_CONFIG.chunkSize;
  const total     = Math.ceil(file.size / chunkSize);

  S.totalChunks = total;
  S.sentChunks  = 0;
  S.startTime   = Date.now();

  // Show transfer screen
  document.getElementById('transfer-file-name-s').textContent = file.name;
  document.getElementById('transfer-file-size-s').textContent = CryptoEngine.formatBytes(file.size);
  showScreen('sender-transfer');
  showBackButton(false);

  // Send file metadata
  S.webrtc.sendJSON({
    t:         'FILE_META',
    name:      file.name,
    size:      file.size,
    mime:      file.type || 'application/octet-stream',
    chunks:    total,
    chunkSize: chunkSize,
  });

  log(`Starting transfer: ${total} chunks × ${CryptoEngine.formatBytes(chunkSize)}`, 'info');

  // Transfer loop
  for (let i = 0; i < total; i++) {
    // Backpressure: wait if DataChannel buffer is too full
    while (S.webrtc.bufferedAmount > 8 * 1024 * 1024) { // 8 MB threshold
      await sleep(50);
    }

    const start       = i * chunkSize;
    const end         = Math.min(start + chunkSize, file.size);
    const plainBuf    = await file.slice(start, end).arrayBuffer();
    const encBuf      = await S.crypto.encryptChunk(plainBuf);

    // Packet format: [4-byte uint32 chunk-index BE] + [IV+ciphertext]
    const packet      = new Uint8Array(4 + encBuf.byteLength);
    new DataView(packet.buffer).setUint32(0, i, false);
    packet.set(new Uint8Array(encBuf), 4);

    S.webrtc.sendBinary(packet.buffer);

    S.sentChunks = i + 1;
    updateSenderProgress(S.sentChunks, total, file.size);
  }

  S.webrtc.sendJSON({ t: 'DONE' });
  log('All chunks sent', 'ok');

  // After a short delay, show done screen
  setTimeout(() => showSenderDone(), 800);
}

function updateSenderProgress(sent, total, fileSize) {
  const pct   = Math.round((sent / total) * 100);
  const elapsed  = (Date.now() - S.startTime) / 1000;
  const bytesSent = (sent / total) * fileSize;
  const speed = elapsed > 0.5 ? CryptoEngine.formatBytes(bytesSent / elapsed) + '/S' : '-- KB/S';

  document.getElementById('progress-fill-s').style.width    = pct + '%';
  document.getElementById('progress-pct-s').textContent     = pct + '%';
  document.getElementById('progress-chunks-s').textContent  = `${sent} / ${total} CHUNKS`;
  document.getElementById('progress-speed-s').textContent   = speed;
}

function showSenderDone() {
  const elapsed = ((Date.now() - S.startTime) / 1000).toFixed(1) + 'S';
  const speed   = CryptoEngine.formatBytes(S.file.size / ((Date.now() - S.startTime) / 1000)) + '/S';

  document.getElementById('done-filename-s').textContent = S.file.name;
  document.getElementById('done-size-s').textContent     = CryptoEngine.formatBytes(S.file.size);
  document.getElementById('done-time-s').textContent     = elapsed;
  document.getElementById('done-speed-s').textContent    = speed;

  showScreen('sender-done');
  showBackButton(false);
  log('Transfer complete!', 'ok');

  // Cleanup Firebase room (it's no longer needed)
  S.signaling?.deleteRoom(S.roomCode);
}

document.getElementById('btn-send-again').addEventListener('click', () => {
  cleanupSession();
  S = createEmptyState();
  S.role = 'sender';
  showScreen('sender-select');
  showBackButton(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVER SESSION — 3 CONNECTION METHODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry point for receiver mode.
 * @param {string|null} autoCode — pre-detected code (from URL or QR)
 */
function initReceiverConnect(autoCode) {
  showScreen('receiver-connect');
  showBackButton(true);

  // ── Method A: URL parameter auto-detection ──────────────────────
  const urlCode = new URLSearchParams(window.location.search).get('room');
  const detected = autoCode || urlCode;

  if (detected) {
    const code = extractCode(detected);
    if (code) {
      document.getElementById('method-url').classList.remove('hidden');
      document.getElementById('connect-divider').classList.remove('hidden');
      document.getElementById('auto-room-code').textContent = code;
      log(`URL room code detected: ${code}`, 'ok');

      document.getElementById('btn-auto-connect').onclick = () => {
        joinRoom(code);
      };
    }
  }

  // ── Method C: Manual entry ───────────────────────────────────────
  const codeInput = document.getElementById('code-input');
  codeInput.focus();
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  });

  document.getElementById('btn-manual-connect').addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 5) {
      codeInput.classList.add('input-error');
      setTimeout(() => codeInput.classList.remove('input-error'), 1000);
      return;
    }
    joinRoom(code);
  });

  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-manual-connect').click();
  });

  // ── Tabs ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');

      // Stop scanner when switching away
      if (btn.dataset.tab !== 'scan') stopScanner();
    });
  });

  // ── Method B: In-app QR scanner ──────────────────────────────────
  document.getElementById('btn-start-scan').addEventListener('click', startScanner);
  document.getElementById('btn-stop-scan').addEventListener('click', stopScanner);
}

// ─── QR SCANNER ───────────────────────────────────────────────────────────────

function startScanner() {
  if (S.scannerRunning) return;
  document.getElementById('btn-start-scan').classList.add('hidden');
  document.getElementById('btn-stop-scan').classList.remove('hidden');

  // Html5Qrcode is a global loaded from CDN
  S.qrScanner = new Html5Qrcode('qr-reader');
  S.scannerRunning = true;

  S.qrScanner.start(
    { facingMode: 'environment' },
    { fps: 12, qrbox: { width: 240, height: 240 } },
    (decodedText) => {
      // QR scanned successfully
      const code = extractCode(decodedText);
      if (code) {
        document.getElementById('scan-result').textContent = `DETECTED: ${code}`;
        document.getElementById('scan-result').classList.remove('hidden');
        log(`QR scanned: ${code}`, 'ok');
        stopScanner();
        setTimeout(() => joinRoom(code), 600);
      }
    },
    () => { /* ignore per-frame errors */ }
  ).catch((err) => {
    log('Camera access denied: ' + err, 'err');
    showScanError('Camera access denied. Please allow camera permissions.');
    S.scannerRunning = false;
    document.getElementById('btn-start-scan').classList.remove('hidden');
    document.getElementById('btn-stop-scan').classList.add('hidden');
  });
}

function stopScanner() {
  if (S.qrScanner && S.scannerRunning) {
    S.qrScanner.stop().catch(() => {});
    S.scannerRunning = false;
  }
  document.getElementById('btn-start-scan')?.classList.remove('hidden');
  document.getElementById('btn-stop-scan')?.classList.add('hidden');
}

function showScanError(msg) {
  const el = document.getElementById('scan-result');
  el.textContent = '✕ ' + msg;
  el.classList.remove('hidden');
  el.style.borderColor = 'var(--pink)';
  el.style.color = 'var(--pink)';
}

/**
 * Extract a 5-char room code from raw text (URL or plain code).
 * @param {string} text
 * @returns {string|null}
 */
function extractCode(text) {
  if (!text) return null;
  text = text.trim();

  // Try as URL first
  try {
    const url  = new URL(text);
    const code = url.searchParams.get('room');
    if (code && /^[A-Z2-9]{5}$/i.test(code)) {
      return code.toUpperCase();
    }
  } catch {}

  // Fallback: treat as raw 5-char code
  const cleaned = text.toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (cleaned.length === 5) return cleaned;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVER — JOIN ROOM & HANDSHAKE
// ─────────────────────────────────────────────────────────────────────────────

async function joinRoom(code) {
  S.roomCode = code;
  stopScanner();
  showScreen('receiver-connecting');
  showBackButton(true);

  const setStep = (n) => {
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById(`conn-step-${i}`);
      if (!el) continue;
      el.classList.toggle('active', i === n);
      if (i < n) el.classList.add('done');
    }
  };

  try {
    // Step 1: Fetch room from Firebase
    setStep(1);
    S.signaling = new SignalingManager(FIREBASE_CONFIG);
    const room  = await S.signaling.fetchOffer(code);

    if (!room) {
      throw new Error(`Room "${code}" not found. Check the code and try again.`);
    }
    log('Room data fetched', 'ok');

    // Step 2: Key exchange
    setStep(2);
    S.crypto = new CryptoEngine();
    await S.crypto.init();
    await S.crypto.deriveSharedKey(room.senderPubKeyJwk);
    log('AES-256-GCM shared key derived (ECDH)', 'ok');

    const receiverPubKey = await S.crypto.exportPublicKey();

    // Step 3: WebRTC answer
    setStep(3);
    S.webrtc = new WebRTCManager(APP_CONFIG.iceServers, APP_CONFIG.iceGatherTimeout, {
      onOpen:    () => onReceiverPeerConnected(),
      onClose:   () => log('Peer connection closed'),
      onMessage: (data) => onReceiverMessage(data),
      onError:   (e) => log('DataChannel error: ' + e.message, 'err'),
    });

    const answerSdp = await S.webrtc.createAnswer(room.offerSdp);
    log('Answer created (ICE gathered)', 'ok');

    // Step 4: Publish answer to Firebase
    setStep(4);
    await S.signaling.publishAnswer(code, answerSdp, receiverPubKey);
    log('Answer published to Firebase', 'ok');

  } catch (err) {
    const errEl = document.getElementById('conn-error-msg');
    errEl.textContent = '✕ ' + err.message;
    errEl.classList.remove('hidden');
    log('Connection error: ' + err.message, 'err');

    setTimeout(() => showError(err.message), 2000);
  }
}

function onReceiverPeerConnected() {
  log('WebRTC peer connected! (receiver)', 'ok');
  // Send READY signal
  S.webrtc.sendJSON({ t: 'READY' });
  log('Sent READY to sender', 'ok');
  // Wait for FILE_META — handled in onReceiverMessage
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIVER MESSAGE HANDLER & DECRYPTION
// ─────────────────────────────────────────────────────────────────────────────

function onReceiverMessage(data) {
  if (typeof data === 'string') {
    handleReceiverControlMessage(JSON.parse(data));
  } else {
    handleReceiverChunk(data); // ArrayBuffer
  }
}

function handleReceiverControlMessage(msg) {
  if (msg.t === 'FILE_META') {
    S.fileInfo      = msg;
    S.totalChunks   = msg.chunks;
    S.receivedChunks = new Map();
    S.startTime     = Date.now();
    log(`Incoming: ${msg.name} (${CryptoEngine.formatBytes(msg.size)}, ${msg.chunks} chunks)`, 'ok');

    // Show transfer screen
    document.getElementById('transfer-file-name-r').textContent = msg.name;
    document.getElementById('transfer-file-size-r').textContent = CryptoEngine.formatBytes(msg.size);
    showScreen('receiver-transfer');
    showBackButton(false);

  } else if (msg.t === 'DONE') {
    log('DONE signal received — assembling file', 'ok');
    assembleFile();
  }
}

async function handleReceiverChunk(buffer) {
  if (!S.fileInfo) return;

  // Parse packet: [4-byte uint32 index][IV+ciphertext]
  const view     = new DataView(buffer);
  const index    = view.getUint32(0, false);
  const encBuf   = buffer.slice(4);

  try {
    const plainBuf = await S.crypto.decryptChunk(encBuf);
    S.receivedChunks.set(index, plainBuf);

    const received = S.receivedChunks.size;
    updateReceiverProgress(received, S.totalChunks, S.fileInfo.size);

    if (received >= S.totalChunks) {
      log('All chunks decrypted', 'ok');
    }
  } catch (err) {
    log(`Decryption error on chunk ${index}: ${err.message}`, 'err');
    showError('Decryption failed — file may be corrupt or tampered.');
  }
}

function updateReceiverProgress(received, total, fileSize) {
  const pct     = Math.round((received / total) * 100);
  const elapsed = (Date.now() - S.startTime) / 1000;
  const bytes   = (received / total) * fileSize;
  const speed   = elapsed > 0.5 ? CryptoEngine.formatBytes(bytes / elapsed) + '/S' : '-- KB/S';

  document.getElementById('progress-fill-r').style.width   = pct + '%';
  document.getElementById('progress-pct-r').textContent    = pct + '%';
  document.getElementById('progress-chunks-r').textContent = `${received} / ${total} CHUNKS`;
  document.getElementById('progress-speed-r').textContent  = speed;
}

async function assembleFile() {
  const info   = S.fileInfo;
  const chunks = [];

  for (let i = 0; i < S.totalChunks; i++) {
    const chunk = S.receivedChunks.get(i);
    if (!chunk) {
      log(`Missing chunk ${i}`, 'err');
      showError(`File assembly failed: chunk ${i} missing.`);
      return;
    }
    chunks.push(chunk);
  }

  const blob = new Blob(chunks, { type: info.mime || 'application/octet-stream' });
  S.downloadUrl = URL.createObjectURL(blob);

  // Show done screen
  const elapsed = ((Date.now() - S.startTime) / 1000).toFixed(1) + 'S';
  const speed   = CryptoEngine.formatBytes(info.size / ((Date.now() - S.startTime) / 1000)) + '/S';

  document.getElementById('done-filename-r').textContent = info.name;
  document.getElementById('done-size-r').textContent     = CryptoEngine.formatBytes(info.size);
  document.getElementById('done-time-r').textContent     = elapsed;
  document.getElementById('done-speed-r').textContent    = speed;

  const dlLink = document.getElementById('download-link');
  dlLink.href     = S.downloadUrl;
  dlLink.download = info.name;
  dlLink.textContent = `▼ DOWNLOAD ${info.name}`;

  showScreen('receiver-done');
  showBackButton(false);
  log(`File ready: ${info.name}`, 'ok');

  // Auto-trigger download
  dlLink.click();

  // Cleanup Firebase room
  S.signaling?.deleteRoom(S.roomCode);
}

document.getElementById('btn-receive-again').addEventListener('click', () => {
  if (S.downloadUrl) URL.revokeObjectURL(S.downloadUrl);
  cleanupSession();
  S = createEmptyState();
  S.role = 'receiver';
  initReceiverConnect(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────────────

function cleanupSession() {
  stopScanner();
  S.webrtc?.close();
  S.signaling?.cleanup();
  if (S.answerUnsub) { try { S.answerUnsub(); } catch {} }
  if (S.downloadUrl) URL.revokeObjectURL(S.downloadUrl);

  // Clear URL param without reload
  const url = new URL(window.location.href);
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    history.replaceState({}, '', url.toString());
  }
}

window.addEventListener('beforeunload', () => {
  if (S.roomCode && S.signaling) S.signaling.deleteRoom(S.roomCode);
});

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE SETUP OVERLAY
// ─────────────────────────────────────────────────────────────────────────────

function showFirebaseOverlay() {
  document.getElementById('setup-overlay').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// INITIALISE
// ─────────────────────────────────────────────────────────────────────────────

function init() {
  // Show log console if enabled
  if (APP_CONFIG.showLog) {
    document.getElementById('log-console').classList.remove('hidden');
  }

  // Show Firebase setup overlay if not configured
  if (!FIREBASE_CONFIGURED) {
    showFirebaseOverlay();
    return;
  }

  // ── Method A: Auto-detect room code from URL ──────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    const code = extractCode(roomParam);
    if (code) {
      log(`Auto-detected room code from URL: ${code}`, 'ok');
      // Start in receiver mode automatically
      S = createEmptyState();
      S.role = 'receiver';
      initReceiverConnect(code);
      return;
    }
  }

  // Normal home screen
  showScreen('home');
}

init();
