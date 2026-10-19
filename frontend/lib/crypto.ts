/**
 * crypto.ts
 * Client-side cryptographic utilities for Nigeria CEWS.
 * Uses the Web Crypto API exclusively — no external dependencies.
 *
 * Key exchange model:
 *   1. Server has a long-lived ECDH P-256 public key (published at /api/v1/pubkey).
 *   2. Client generates an ephemeral ECDH key pair per report.
 *   3. Client derives a session key: ECDH shared secret → HKDF → AES-256-GCM key.
 *   4. Client encrypts the report payload with the session key.
 *   5. Client sends { ciphertext, ephemeral_public_key } to the server.
 *   6. Server repeats derivation with its private key + client ephemeral public key.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ECDHKeyPair {
  /** Non-extractable private key — stays in browser memory only */
  privateKey: CryptoKey;
  /** Extractable public key — sent to the server */
  publicKey: CryptoKey;
}

export interface EncryptedPayload {
  /** Base64url-encoded ciphertext with 12-byte nonce prepended */
  ciphertext: string;
  /** Base64url-encoded SPKI-formatted ephemeral public key */
  ephemeralPublicKey: string;
}

export interface DecryptedPayload<T = unknown> {
  data: T;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const crypto = globalThis.crypto;

function assertWebCrypto(): void {
  if (!crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available in this environment.');
  }
}

/** Encode ArrayBuffer to base64url (no padding) */
function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Decode base64url string to ArrayBuffer */
function base64UrlToBuffer(b64: string): ArrayBuffer {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Generate 12 cryptographically random bytes for AES-GCM nonce */
function generateNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

/** Encode a UTF-8 string to ArrayBuffer */
function encodeUTF8(str: string): ArrayBuffer {
  return new TextEncoder().encode(str);
}

/** Decode ArrayBuffer to UTF-8 string */
function decodeUTF8(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an ephemeral ECDH P-256 key pair.
 * - privateKey: non-extractable (never leaves the browser)
 * - publicKey: extractable (sent to the server in SPKI format)
 */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  assertWebCrypto();

  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false, // privateKey is NOT extractable
    ['deriveKey', 'deriveBits']
  );

  // Re-import public key as extractable so we can export it
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const extractablePublicKey = await crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // extractable
    []
  );

  return {
    privateKey: keyPair.privateKey,
    publicKey: extractablePublicKey,
  };
}

/**
 * Export a CryptoKey (public, ECDH P-256) to base64url SPKI format.
 */
export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  assertWebCrypto();
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return bufferToBase64Url(spki);
}

/**
 * Import a base64url SPKI-formatted server public key for ECDH.
 */
export async function importServerPublicKey(spkiBase64Url: string): Promise<CryptoKey> {
  assertWebCrypto();
  const buffer = base64UrlToBuffer(spkiBase64Url);
  return crypto.subtle.importKey(
    'spki',
    buffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

/**
 * Derive a session AES-256-GCM key from an ECDH key pair and the peer's public key.
 *
 * Process:
 *   1. ECDH: sharedSecret = privateKey × peerPublicKey
 *   2. HKDF with SHA-256, salt = random 32 bytes (passed as info to keep API simple,
 *      actual salt is zeroed for determinism — server must mirror this), info = "CEWS-v1"
 *   3. Output: 256-bit AES-GCM key
 */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt?: ArrayBuffer
): Promise<{ sessionKey: CryptoKey; saltBase64Url: string }> {
  assertWebCrypto();

  const resolvedSalt = salt ?? new Uint8Array(32).buffer; // zero salt — deterministic
  const saltBase64Url = bufferToBase64Url(resolvedSalt);

  // Step 1: Derive raw shared bits via ECDH
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );

  // Step 2: Import shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  // Step 3: Derive AES-256-GCM key via HKDF-SHA-256
  const sessionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: resolvedSalt,
      info: encodeUTF8('CEWS-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable session key
    ['encrypt', 'decrypt']
  );

  return { sessionKey, saltBase64Url };
}

/**
 * Encrypt an arbitrary payload object using a derived session key.
 *
 * Format: base64url( nonce[12] || ciphertext )
 */
export async function encryptPayload<T = unknown>(
  payload: T,
  sessionKey: CryptoKey
): Promise<string> {
  assertWebCrypto();

  const nonce = generateNonce();
  const plaintext = encodeUTF8(JSON.stringify(payload));

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    sessionKey,
    plaintext
  );

  // Prepend nonce (12 bytes) to ciphertext
  const combined = new Uint8Array(nonce.byteLength + ciphertextBuffer.byteLength);
  combined.set(nonce, 0);
  combined.set(new Uint8Array(ciphertextBuffer), nonce.byteLength);

  return bufferToBase64Url(combined.buffer);
}

/**
 * Decrypt a payload produced by `encryptPayload`.
 * Slices the 12-byte nonce from the front, then decrypts.
 */
export async function decryptPayload<T = unknown>(
  ciphertextBase64Url: string,
  sessionKey: CryptoKey
): Promise<DecryptedPayload<T>> {
  assertWebCrypto();

  const combined = new Uint8Array(base64UrlToBuffer(ciphertextBase64Url));

  if (combined.byteLength < 13) {
    throw new Error('Ciphertext is too short to contain a valid nonce + payload.');
  }

  const nonce = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      sessionKey,
      ciphertext
    );
  } catch {
    throw new Error('Decryption failed — the payload may be corrupt or the key incorrect.');
  }

  const plaintext = decodeUTF8(plaintextBuffer);

  let data: T;
  try {
    data = JSON.parse(plaintext) as T;
  } catch {
    throw new Error('Decrypted payload is not valid JSON.');
  }

  return { data };
}

/**
 * Compute a SHA-256 hex digest of the JSON-serialised payload.
 * Used as a tamper-detection checksum stored alongside the ciphertext.
 */
export async function computeChecksum<T = unknown>(payload: T): Promise<string> {
  assertWebCrypto();
  const buffer = encodeUTF8(JSON.stringify(payload));
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * High-level helper: generate keys, derive session key, encrypt, and return
 * everything needed to send an encrypted report.
 *
 * @param payload   The report data object to encrypt
 * @param serverPublicKeyB64  Base64url SPKI of the server's ECDH public key
 */
export async function sealReport<T = unknown>(
  payload: T,
  serverPublicKeyB64: string
): Promise<{
  ciphertext: string;
  ephemeralPublicKey: string;
  saltBase64Url: string;
  checksum: string;
}> {
  const serverPublicKey = await importServerPublicKey(serverPublicKeyB64);
  const ephemeralPair = await generateECDHKeyPair();
  const { sessionKey, saltBase64Url } = await deriveSessionKey(
    ephemeralPair.privateKey,
    serverPublicKey
  );
  const [ciphertext, ephemeralPublicKey, checksum] = await Promise.all([
    encryptPayload(payload, sessionKey),
    exportPublicKey(ephemeralPair.publicKey),
    computeChecksum(payload),
  ]);
  return { ciphertext, ephemeralPublicKey, saltBase64Url, checksum };
}
