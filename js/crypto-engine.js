/**
 * PixelDrop — js/crypto-engine.js
 *
 * Implements end-to-end encryption using:
 *   • ECDH P-256  — ephemeral key pair per session for key agreement
 *   • AES-256-GCM — authenticated encryption of file chunks
 *
 * Key exchange flow:
 *   1. Both peers generate an ECDH key pair independently.
 *   2. They exchange their public keys via the Firebase signaling channel
 *      (which is itself TLS-encrypted).
 *   3. Each peer derives a shared 256-bit AES key via ECDH without any
 *      secret ever being transmitted. The shared key is identical on both
 *      sides by the properties of Diffie-Hellman.
 *   4. Each file chunk is encrypted with a fresh 96-bit random IV.
 *      GCM's authentication tag (128-bit) detects any tampering.
 *
 * Binary chunk wire format:
 *   ┌──────────┬─────────────────────────────────────────────────────┐
 *   │ 12 bytes │  N bytes                                            │
 *   │   IV     │  AES-256-GCM ciphertext + 16-byte auth tag          │
 *   └──────────┴─────────────────────────────────────────────────────┘
 */
export class CryptoEngine {
  constructor() {
    /** @type {CryptoKeyPair|null} */
    this._keyPair   = null;
    /** @type {CryptoKey|null} — derived AES-GCM key */
    this._sharedKey = null;
  }

  // ─── SETUP ────────────────────────────────────────────────────────

  /**
   * Generate an ephemeral ECDH P-256 key pair for this session.
   * Must be called before exportPublicKey() or deriveSharedKey().
   */
  async init() {
    this._keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,           // extractable (we need to export the public key)
      ['deriveKey']
    );
  }

  /**
   * Export the local ECDH public key as a JWK object for transmission
   * to the remote peer via the signaling channel.
   * @returns {Promise<JsonWebKey>}
   */
  async exportPublicKey() {
    if (!this._keyPair) throw new Error('CryptoEngine not initialised');
    return crypto.subtle.exportKey('jwk', this._keyPair.publicKey);
  }

  /**
   * Derive the shared AES-256-GCM key from the remote peer's public key.
   * This must be called before encryptChunk / decryptChunk.
   *
   * @param {JsonWebKey} remotePublicKeyJwk — received from signaling
   * @returns {Promise<CryptoKey>}
   */
  async deriveSharedKey(remotePublicKeyJwk) {
    if (!this._keyPair) throw new Error('CryptoEngine not initialised');

    const remotePublicKey = await crypto.subtle.importKey(
      'jwk',
      remotePublicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,   // not extractable
      []       // no key usages — only used as "public" in ECDH
    );

    this._sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: remotePublicKey },
      this._keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,                          // derived key is not extractable
      ['encrypt', 'decrypt']
    );

    return this._sharedKey;
  }

  /** @returns {boolean} True once the shared key has been derived. */
  get isReady() { return this._sharedKey !== null; }

  // ─── ENCRYPTION ───────────────────────────────────────────────────

  /**
   * Encrypt a single chunk buffer with AES-256-GCM.
   * A fresh 12-byte random IV is generated for every call.
   *
   * @param {ArrayBuffer} chunkBuffer — plaintext chunk
   * @returns {Promise<ArrayBuffer>} — packed [IV | ciphertext+tag]
   */
  async encryptChunk(chunkBuffer) {
    if (!this._sharedKey) throw new Error('Shared key not derived');

    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this._sharedKey,
      chunkBuffer
    );

    // Pack: IV (12 bytes) || ciphertext+tag
    const packed = new Uint8Array(12 + encrypted.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(encrypted), 12);
    return packed.buffer;
  }

  // ─── DECRYPTION ───────────────────────────────────────────────────

  /**
   * Decrypt a packed [IV | ciphertext+tag] buffer.
   *
   * @param {ArrayBuffer} packedBuffer — received over DataChannel
   * @returns {Promise<ArrayBuffer>} — decrypted plaintext chunk
   */
  async decryptChunk(packedBuffer) {
    if (!this._sharedKey) throw new Error('Shared key not derived');

    const packed     = new Uint8Array(packedBuffer);
    const iv         = packed.slice(0, 12);
    const ciphertext = packed.slice(12);

    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this._sharedKey,
      ciphertext
    );
  }

  // ─── STATIC HELPERS ───────────────────────────────────────────────

  /**
   * Format bytes into a human-readable string.
   * @param {number} bytes
   * @returns {string}
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k     = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i     = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
  }
}
