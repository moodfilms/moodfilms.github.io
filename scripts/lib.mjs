// Shared crypto helpers for the Node scripts (same primitives the browser uses).
import { webcrypto } from "node:crypto";
export const { subtle } = webcrypto;
export const ITERATIONS = 300000;
const enc = new TextEncoder();
export const b64 = (buf) => Buffer.from(buf).toString("base64");
export const b64d = (s) => Buffer.from(s, "base64");
export async function sha(text) { return Buffer.from(await subtle.digest("SHA-256", enc.encode(text))).toString("hex").slice(0, 24); }
export async function deriveKek(password, salt, iterations = ITERATIONS) {
  const base = await subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}
export const newKey = () => subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
export async function wrap(key, kek) { const iv = webcrypto.getRandomValues(new Uint8Array(12)); return { iv: b64(iv), wrapped: b64(await subtle.wrapKey("raw", key, kek, { name: "AES-GCM", iv })) }; }
export const unwrap = (w, kek) => subtle.unwrapKey("raw", b64d(w.wrapped), kek, { name: "AES-GCM", iv: b64d(w.iv) }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
export async function encryptJSON(obj, key) { const iv = webcrypto.getRandomValues(new Uint8Array(12)); return { iv: b64(iv), ct: b64(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)))) }; }
export async function decryptJSON({ iv, ct }, key) { return JSON.parse(Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, key, b64d(ct))).toString()); }
export const randomId = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString("hex");
