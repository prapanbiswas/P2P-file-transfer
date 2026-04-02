/**
 * PixelDrop — js/webrtc-manager.js
 *
 * Manages a single WebRTC peer connection with one ordered RTCDataChannel.
 *
 * Uses "vanilla ICE":
 *   Wait for ICE gathering to fully complete before returning the local
 *   SDP description. This means all candidates are embedded in the SDP
 *   and no separate trickle-ICE signaling is needed.
 *
 * DataChannel message protocol:
 * ─────────────────────────────────────────────────────────────────────
 *  JSON strings (control messages):
 *    { t: "KEY_EXCHANGE", pk: JsonWebKey }   — ECDH public key share
 *    { t: "FILE_META", name, size, mime, chunks, chunkSize }
 *    { t: "READY" }                          — receiver ready to receive
 *    { t: "DONE" }                           — sender finished all chunks
 *    { t: "CANCEL" }                         — abort transfer
 *
 *  ArrayBuffer (binary — encrypted chunk packets):
 *    ┌──────────┬──────────┬─────────────────────────────────┐
 *    │ 4 bytes  │ 12 bytes │  N bytes                         │
 *    │ chunk idx│   IV     │  AES-256-GCM ciphertext + tag    │
 *    └──────────┴──────────┴─────────────────────────────────┘
 *    chunk idx is big-endian uint32.
 * ─────────────────────────────────────────────────────────────────────
 */
export class WebRTCManager {

  /**
   * @param {RTCIceServer[]} iceServers
   * @param {number}         iceGatherTimeout  — seconds
   * @param {{
   *   onOpen:         function,
   *   onClose:        function,
   *   onMessage:      function(string|ArrayBuffer),
   *   onError:        function(Error),
   * }} callbacks
   */
  constructor(iceServers, iceGatherTimeout, callbacks) {
    this._iceServers       = iceServers;
    this._iceGatherTimeout = iceGatherTimeout * 1000;
    this._callbacks        = callbacks;

    /** @type {RTCPeerConnection|null} */
    this._pc = null;
    /** @type {RTCDataChannel|null} */
    this._dc = null;

    this._opened = false;
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────

  _createPC() {
    this._pc = new RTCPeerConnection({ iceServers: this._iceServers });

    // Track connection state changes
    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      if (s === 'connected' && !this._opened) {
        this._opened = true;
        this._callbacks.onOpen?.();
      }
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this._callbacks.onClose?.();
      }
    };

    return this._pc;
  }

  _attachDataChannel(dc) {
    this._dc          = dc;
    this._dc.binaryType = 'arraybuffer';

    this._dc.onopen = () => {
      if (!this._opened) {
        this._opened = true;
        this._callbacks.onOpen?.();
      }
    };
    this._dc.onclose   = () => this._callbacks.onClose?.();
    this._dc.onerror   = (e) => this._callbacks.onError?.(e.error ?? new Error('DataChannel error'));
    this._dc.onmessage = (e) => this._callbacks.onMessage?.(e.data);
  }

  /**
   * Wait for ICE gathering to complete.
   * Resolves on null-candidate event or after timeout.
   * @returns {Promise<void>}
   */
  _waitForICE() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this._iceGatherTimeout);

      const done = () => {
        clearTimeout(timer);
        resolve();
      };

      if (this._pc.iceGatheringState === 'complete') { done(); return; }

      this._pc.onicegatheringstatechange = () => {
        if (this._pc.iceGatheringState === 'complete') done();
      };
      this._pc.onicecandidate = (e) => {
        if (!e.candidate) done(); // null candidate = gathering done
      };
    });
  }

  // ─── SENDER (initiator) ───────────────────────────────────────────

  /**
   * Create offer SDP (sender side).
   * Waits for ICE gathering to complete.
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async createOffer() {
    this._createPC();

    // Create the data channel BEFORE creating the offer so the offer
    // includes the data channel m-line.
    const dc = this._pc.createDataChannel('transfer', {
      ordered:          true,
      maxRetransmits:   null,   // reliable delivery
    });
    this._attachDataChannel(dc);

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    await this._waitForICE();

    return this._pc.localDescription;
  }

  /**
   * Complete the handshake on the sender side after receiving the answer.
   * @param {RTCSessionDescriptionInit} answerSdp
   */
  async setRemoteAnswer(answerSdp) {
    await this._pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
  }

  // ─── RECEIVER (answerer) ──────────────────────────────────────────

  /**
   * Create answer SDP (receiver side).
   * Waits for ICE gathering to complete.
   * @param {RTCSessionDescriptionInit} offerSdp
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async createAnswer(offerSdp) {
    this._createPC();

    // The data channel is created by the sender; we receive it here.
    this._pc.ondatachannel = (e) => this._attachDataChannel(e.channel);

    await this._pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    await this._waitForICE();

    return this._pc.localDescription;
  }

  // ─── SENDING ──────────────────────────────────────────────────────

  /**
   * Send a JSON control message.
   * @param {object} obj
   */
  sendJSON(obj) {
    if (!this._isOpen()) return;
    this._dc.send(JSON.stringify(obj));
  }

  /**
   * Send a raw binary ArrayBuffer (encrypted chunk).
   * @param {ArrayBuffer} buffer
   */
  sendBinary(buffer) {
    if (!this._isOpen()) return;
    this._dc.send(buffer);
  }

  /** @returns {number} DataChannel buffer backpressure level in bytes. */
  get bufferedAmount() {
    return this._dc ? this._dc.bufferedAmount : 0;
  }

  _isOpen() {
    return this._dc && this._dc.readyState === 'open';
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────

  close() {
    try { this._dc?.close(); } catch {}
    try { this._pc?.close(); } catch {}
    this._dc = null;
    this._pc = null;
  }
}
