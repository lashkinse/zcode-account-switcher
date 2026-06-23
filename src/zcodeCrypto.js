'use strict';
/**
 * ZCode credentials enc:v1 encryption/decryption
 *
 * Confirmed after reverse-engineering ZCode app.asar:
 *   - Algorithm: aes-256-gcm
 *   - Format: enc:v1:<nonce_base64url>.<authTag_base64url>.<cipherText_base64url>
 *   - key: sha256(secret)
 *   - secret: prioritizes process.env.ZCODE_CREDENTIAL_SECRET, otherwise
 *     `zcode-credential-fallback:${platform}:${homedir}:${username}`
 *
 * This allows the tool to read/write encrypted fields of credentials.json in the current Windows user environment.
 */
const crypto = require('crypto');
const os = require('os');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const NONCE_SIZE = 12;
const CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';

function defaultCredentialSecret(env = process.env) {
  if (env[CREDENTIAL_SECRET_ENV]) return env[CREDENTIAL_SECRET_ENV];
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (_) {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function deriveKey(secret = defaultCredentialSecret()) {
  return crypto.createHash('sha256').update(secret).digest();
}

function b64urlToBuffer(s) {
  return Buffer.from(s, 'base64url');
}

function bufferToB64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function decrypt(value, secret = defaultCredentialSecret()) {
  if (!isEncrypted(value)) return value;
  const body = value.slice(PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 3) throw new Error('Invalid enc:v1 format');

  const [noncePart, tagPart, cipherPart] = parts;
  const nonce = b64urlToBuffer(noncePart);
  const tag = b64urlToBuffer(tagPart);
  const cipherText = b64urlToBuffer(cipherPart);
  const decipher = crypto.createDecipheriv(ALGO, deriveKey(secret), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

function encrypt(plainText, secret = defaultCredentialSecret()) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(secret), nonce);
  const cipherText = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [PREFIX, bufferToB64url(nonce), '.', bufferToB64url(tag), '.', bufferToB64url(cipherText)].join('');
}

function tryJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function decryptJson(value, secret = defaultCredentialSecret()) {
  const plain = decrypt(value, secret);
  return tryJson(plain);
}

module.exports = {
  PREFIX,
  isEncrypted,
  defaultCredentialSecret,
  deriveKey,
  decrypt,
  encrypt,
  decryptJson,
};
