// Builds the published site: encrypts each client's data so the public host only ever
// holds ciphertext. A client password unlocks that client's bundle; the team password
// unlocks every bundle plus the internal ones.
//
//   node scripts/build.mjs
//
// Reads config/clients.json and the data files it points at. Writes docs/data/.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { subtle } = webcrypto;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "data");
const ITERATIONS = 300000;
const enc = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString("base64");

const cfgPath = path.join(root, "config", "clients.json");
if (!existsSync(cfgPath)) {
  console.error("config/clients.json is missing. Copy config/clients.example.json and fill it in.");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

async function sha(text) {
  const h = await subtle.digest("SHA-256", enc.encode(text));
  return Buffer.from(h).toString("hex").slice(0, 24);
}
async function deriveKey(password, salt) {
  const base = await subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, base,
    { name: "AES-GCM", length: 256 }, false, ["wrapKey", "encrypt"]);
}
async function wrap(contentKey, kek) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrapped = await subtle.wrapKey("raw", contentKey, kek, { name: "AES-GCM", iv });
  return { iv: b64(iv), wrapped: b64(wrapped) };
}
async function encryptJSON(obj, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
function load(rel) {
  const p = path.join(root, rel);
  if (!existsSync(p)) throw new Error(`Data file not found: ${rel}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const accounts = {};
  const bundles = {};
  const teamSalt = webcrypto.getRandomValues(new Uint8Array(16));
  const teamKek = await deriveKey(cfg.team.password, teamSalt);
  const teamAcct = { kind: "team", label: cfg.team.label || "Mood Studio team", salt: b64(teamSalt), iterations: ITERATIONS, keys: {} };
  accounts[await sha("acct:" + cfg.team.username.toLowerCase())] = teamAcct;

  for (const c of cfg.clients) {
    const data = load(c.data);
    data.slug = c.slug;
    const internal = c.internal && existsSync(path.join(root, c.internal)) ? load(c.internal) : { projects: {}, notes: "" };
    internal.slug = c.slug;

    // One random content key per bundle; wrapped for whoever may open it.
    const clientKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const internalKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const clientBundleId = await sha(`bundle:${c.slug}:client:${b64(teamSalt)}`);
    const internalBundleId = await sha(`bundle:${c.slug}:internal:${b64(teamSalt)}`);

    writeFileSync(path.join(out, clientBundleId + ".enc"), JSON.stringify(await encryptJSON({ kind: "client", ...data }, clientKey)));
    writeFileSync(path.join(out, internalBundleId + ".enc"), JSON.stringify(await encryptJSON({ kind: "internal", ...internal }, internalKey)));
    bundles[clientBundleId] = { file: clientBundleId + ".enc" };
    bundles[internalBundleId] = { file: internalBundleId + ".enc" };

    teamAcct.keys[clientBundleId] = await wrap(clientKey, teamKek);
    teamAcct.keys[internalBundleId] = await wrap(internalKey, teamKek);

    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKey(c.password, salt);
    accounts[await sha("acct:" + c.username.toLowerCase())] = {
      kind: "client", salt: b64(salt), iterations: ITERATIONS,
      keys: { [clientBundleId]: await wrap(clientKey, kek) },
    };
    console.log(`  ${c.slug.padEnd(14)} ${data.projects?.length ?? 0} projects${data.sample ? "  (sample data)" : ""}`);
  }

  const manifest = { version: 1, built_at: new Date().toISOString(), accounts, bundles };
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
  console.log(`Built ${Object.keys(bundles).length} bundles for ${cfg.clients.length} client(s) → docs/data/`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
