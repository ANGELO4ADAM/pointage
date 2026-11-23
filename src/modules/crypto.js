/**
 * Moteur cryptographique natif (WebCrypto API SHA-256).
 * Compatible navigateur, Android WebView (Capacitor) et Node.js 20+.
 */

function getSubtle() {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('WebCrypto API indisponible dans cet environnement.');
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256Bytes(uint8OrBuffer) {
  const data = uint8OrBuffer instanceof Uint8Array
    ? uint8OrBuffer
    : new Uint8Array(uint8OrBuffer);
  const digest = await getSubtle().digest('SHA-256', data);
  return bufferToHex(digest);
}

export async function sha256Text(text) {
  const encoded = new TextEncoder().encode(String(text ?? ''));
  return sha256Bytes(encoded);
}

export async function sha256Blob(blob) {
  const buf = await blob.arrayBuffer();
  return sha256Bytes(buf);
}

/**
 * Calcule une empreinte chaînée (mini-blockchain locale) liant l'événement N à N-1.
 */
export async function calculerHashChaine(prevHash, horodatage, action, detail, hashPhoto = '') {
  const payload = `${prevHash || 'GENESIS'}|${horodatage}|${action}|${detail}|${hashPhoto}`;
  return sha256Text(payload);
}

/**
 * Génère une clé secrète aléatoire 256 bits (hex 64 caractères) pour Google Apps Script.
 */
export function genererTokenSecret256() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bufferToHex(bytes);
}

/**
 * Hachage salé SHA-256 itéré (100 000 tours) pour le code PIN local de l'application.
 */
export async function hasherPinLocal(pin, saltHex = '') {
  let salt = saltHex;
  if (!salt) {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    salt = bufferToHex(b);
  }
  const subtle = getSubtle();
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(String(pin)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    256
  );
  return {
    salt,
    hash: `pbkdf2:sha256:100000$${salt}$${bufferToHex(derived)}`
  };
}

export async function verifierPinLocal(pin, storedHash, storedSalt) {
  if (!storedHash || !storedSalt) return true;
  const { hash } = await hasherPinLocal(pin, storedSalt);
  return hash === storedHash;
}
