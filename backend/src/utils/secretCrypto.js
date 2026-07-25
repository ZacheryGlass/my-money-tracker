'use strict';

const crypto = require('crypto');

// AES-256-GCM over secrets stored in the database. The key comes from
// SECRETS_ENCRYPTION_KEY (base64, must decode to exactly 32 bytes).
// Payload format: v1:<iv b64>:<authTag b64>:<ciphertext b64>

function loadKey() {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes of base64 (openssl rand -base64 32)');
  }
  return key;
}

function isConfigured() {
  try {
    return loadKey() !== null;
  } catch {
    return false;
  }
}

function encrypt(plaintext) {
  const key = loadKey();
  if (!key) throw new Error('SECRETS_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(payload) {
  const key = loadKey();
  if (!key) throw new Error('SECRETS_ENCRYPTION_KEY is not configured');
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unrecognized secret payload format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function last4(value) {
  return String(value).slice(-4);
}

function mask(lastFour) {
  return lastFour ? `••••${lastFour}` : null;
}

module.exports = { isConfigured, encrypt, decrypt, last4, mask };
