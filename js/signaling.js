/**
 * PixelDrop — js/signaling.js
 *
 * Firebase Realtime Database signaling for WebRTC session establishment.
 *
 * Firebase DB structure per room:
 * ─────────────────────────────────────────────────────────────────────
 *  /rooms/{CODE}/
 *    offer          : { sdp: string, type: "offer" }
 *    senderPublicKey: string  (JSON-serialised JWK)
 *    answer         : { sdp: string, type: "answer", receiverPublicKey: string }
 *    createdAt      : number  (Unix ms timestamp — for cleanup rules)
 *
 * Vanilla ICE approach:
 *   We wait for the local ICE gathering to complete before writing the
 *   SDP to Firebase. This embeds ALL ICE candidates inside the SDP,
 *   eliminating the need for a separate ICE candidate exchange channel.
 *   Simpler, more reliable, only slightly slower to connect.
 * ─────────────────────────────────────────────────────────────────────
 */

import { initializeApp }                           from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, set, get, onValue,
         remove, serverTimestamp }                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

export class SignalingManager {

  /**
   * @param {import('./config.js').FIREBASE_CONFIG} firebaseConfig
   */
  constructor(firebaseConfig) {
    const app  = initializeApp(firebaseConfig, 'pixeldrop-' + Date.now());
    this._db   = getDatabase(app);
    this._unsubscribers = [];
  }

  // ─── ROOM CODE ────────────────────────────────────────────────────

  /**
   * Generate a random 5-character alphanumeric room code.
   * Uses an unambiguous character set (no O/0, I/1/l, etc.)
   * @returns {string} e.g. "A7X2P"
   */
  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const values = crypto.getRandomValues(new Uint8Array(5));
    for (const v of values) {
      code += chars[v % chars.length];
    }
    return code;
  }

  // ─── SENDER ───────────────────────────────────────────────────────

  /**
   * Write the offer SDP + sender's ECDH public key to Firebase.
   * Called after the local RTCPeerConnection has gathered all ICE candidates.
   *
   * @param {string}       code           — 5-char room code
   * @param {RTCSessionDescriptionInit} offerSdp
   * @param {JsonWebKey}   senderPubKeyJwk
   */
  async publishOffer(code, offerSdp, senderPubKeyJwk) {
    const roomRef = ref(this._db, `rooms/${code}`);
    await set(roomRef, {
      offer: {
        sdp:  offerSdp.sdp,
        type: offerSdp.type,
      },
      senderPublicKey: JSON.stringify(senderPubKeyJwk),
      createdAt:       Date.now(),
    });
  }

  /**
   * Subscribe to the answer node. Resolves once the receiver writes
   * their answer and ECDH public key.
   *
   * @param {string}   code
   * @param {function} callback — called with { answerSdp, receiverPubKeyJwk }
   * @returns {function} unsubscribe
   */
  onAnswer(code, callback) {
    const answerRef  = ref(this._db, `rooms/${code}/answer`);
    const unsub = onValue(answerRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.val();
      callback({
        answerSdp:       { sdp: data.sdp, type: data.type },
        receiverPubKeyJwk: JSON.parse(data.receiverPublicKey),
      });
    });
    this._unsubscribers.push(unsub);
    return unsub;
  }

  // ─── RECEIVER ─────────────────────────────────────────────────────

  /**
   * Fetch the offer SDP + sender's public key for a given room code.
   * @param {string} code
   * @returns {Promise<{offerSdp, senderPubKeyJwk}|null>} null if not found
   */
  async fetchOffer(code) {
    const roomRef = ref(this._db, `rooms/${code}`);
    const snap    = await get(roomRef);
    if (!snap.exists()) return null;

    const data = snap.val();
    if (!data.offer) return null;

    return {
      offerSdp:      { sdp: data.offer.sdp, type: data.offer.type },
      senderPubKeyJwk: JSON.parse(data.senderPublicKey),
    };
  }

  /**
   * Write the answer SDP + receiver's ECDH public key.
   * @param {string}       code
   * @param {RTCSessionDescriptionInit} answerSdp
   * @param {JsonWebKey}   receiverPubKeyJwk
   */
  async publishAnswer(code, answerSdp, receiverPubKeyJwk) {
    const answerRef = ref(this._db, `rooms/${code}/answer`);
    await set(answerRef, {
      sdp:             answerSdp.sdp,
      type:            answerSdp.type,
      receiverPublicKey: JSON.stringify(receiverPubKeyJwk),
    });
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────

  /**
   * Delete the entire room from Firebase.
   * Called when transfer completes or on disconnect.
   * @param {string} code
   */
  async deleteRoom(code) {
    try {
      await remove(ref(this._db, `rooms/${code}`));
    } catch {
      // Best-effort; ignore errors during cleanup.
    }
  }

  /** Detach all Firebase listeners. */
  cleanup() {
    for (const unsub of this._unsubscribers) {
      try { unsub(); } catch {}
    }
    this._unsubscribers = [];
  }
}
