// Builds docs/data/: every client's data encrypted so the public host only ever holds ciphertext.
//
//   node scripts/build.mjs
//
// Sources, in order: config/clients.json (who may log in), data/<slug>.json and data/<slug>.internal.json
// (what they see), and the manifest already in docs/data/ (run scripts/pull.mjs first so it matches the
// live site). Clients that were added or re-keyed in the browser admin keep their accounts and content
// keys; clients listed with a password in the config are re-keyed from that password every build.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ITERATIONS, b64, b64d, sha, deriveKek, newKey, wrap, unwrap, encryptJSON, decryptJSON, randomId } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "data");
const cfgPath = path.join(root, "config", "clients.json");
if (!existsSync(cfgPath)) { console.error("config/clients.json is missing. Copy config/clients.example.json and fill it in."); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const loadJSON = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

async function readLive() {
  // What is in docs/data right now, decrypted with the team password.
  const mp = path.join(out, "manifest.json");
  if (!existsSync(mp)) return { accounts: {}, bySlug: {} };
  const m = JSON.parse(readFileSync(mp, "utf8"));
  const teamId = await sha("acct:" + cfg.team.username.toLowerCase());
  const team = m.accounts[teamId];
  if (!team) return { accounts: m.accounts, bySlug: {} };
  const kek = await deriveKek(process.env.TEAM_OLD_PASSWORD || cfg.team.password, b64d(team.salt), team.iterations);
  const bySlug = {};
  for (const [id, w] of Object.entries(team.keys)) {
    let key;
    try { key = await unwrap(w, kek); } catch { console.error("The team password in config/clients.json does not open the current bundles. If you changed it, run again with TEAM_OLD_PASSWORD=<previous password>."); process.exit(1); }
    const file = path.join(out, m.bundles[id]?.file || "");
    if (!existsSync(file)) continue;
    const b = await decryptJSON(JSON.parse(readFileSync(file, "utf8")), key);
    const s = (bySlug[b.slug] ||= {});
    s[b.kind] = { id, key, data: b };
  }
  return { accounts: m.accounts, bySlug };
}

async function main() {
  mkdirSync(out, { recursive: true });
  const live = await readLive();
  const accounts = {}, bundles = {};
  const teamSalt = webcrypto.getRandomValues(new Uint8Array(16));
  const teamKek = await deriveKek(cfg.team.password, teamSalt);
  const teamAcct = { kind: "team", label: cfg.team.label || "Mood Studio team", salt: b64(teamSalt), iterations: ITERATIONS, keys: {} };
  accounts[await sha("acct:" + cfg.team.username.toLowerCase())] = teamAcct;

  const slugs = [...new Set([...cfg.clients.map((c) => c.slug), ...Object.keys(live.bySlug)])];
  const keep = new Set(["manifest.json"]);
  for (const slug of slugs) {
    const c = cfg.clients.find((x) => x.slug === slug);
    const lv = live.bySlug[slug] || {};
    const dataPath = c?.data || `data/${slug}.json`, intPath = c?.internal || `data/${slug}.internal.json`;
    const data = existsSync(path.join(root, dataPath)) ? loadJSON(dataPath) : lv.client?.data;
    const internal = existsSync(path.join(root, intPath)) ? loadJSON(intPath) : lv.internal?.data || { projects: {}, notes: "", risks: [] };
    if (!data) { console.warn(`  ${slug}: no data file and nothing live; skipped`); continue; }
    delete data.kind; delete internal.kind; data.slug = slug; internal.slug = slug;

    const managedHere = !!(c && c.password);
    const clientKey = managedHere || !lv.client ? await newKey() : lv.client.key;
    const internalKey = managedHere || !lv.internal ? await newKey() : lv.internal.key;
    const clientId = lv.client?.id || await sha(`bundle:${slug}:client:${randomId()}`);
    const internalId = lv.internal?.id || await sha(`bundle:${slug}:internal:${randomId()}`);
    writeFileSync(path.join(out, clientId + ".enc"), JSON.stringify(await encryptJSON({ kind: "client", ...data, updated_at: new Date().toISOString() }, clientKey)));
    writeFileSync(path.join(out, internalId + ".enc"), JSON.stringify(await encryptJSON({ kind: "internal", ...internal }, internalKey)));
    keep.add(clientId + ".enc"); keep.add(internalId + ".enc");
    bundles[clientId] = { file: clientId + ".enc" }; bundles[internalId] = { file: internalId + ".enc" };
    teamAcct.keys[clientId] = await wrap(clientKey, teamKek);
    teamAcct.keys[internalId] = await wrap(internalKey, teamKek);

    if (managedHere) {
      const salt = webcrypto.getRandomValues(new Uint8Array(16));
      const kek = await deriveKek(c.password, salt);
      accounts[await sha("acct:" + c.username.toLowerCase())] = { kind: "client", slug, salt: b64(salt), iterations: ITERATIONS, keys: { [clientId]: await wrap(clientKey, kek) } };
    } else {
      // Keep the account(s) that already open this client's bundle (passcode set in the browser).
      let found = 0;
      for (const [id, a] of Object.entries(live.accounts)) if (a.kind === "client" && a.keys[clientId]) { accounts[id] = a; found++; }
      if (!found) console.warn(`  ${slug}: no login found. Give it a password in config/clients.json or add one in the browser admin.`);
    }
    console.log(`  ${slug.padEnd(14)} ${(data.projects || []).length} projects${managedHere ? "" : "  (login managed in the browser)"}${data.sample ? "  (sample data)" : ""}`);
  }
  for (const f of readdirSync(out)) if (!keep.has(f)) unlinkSync(path.join(out, f));
  const manifest = { version: 2, built_at: new Date().toISOString(), hub: cfg.hub || null, accounts, bundles };
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
  console.log(`Built ${Object.keys(bundles).length} bundles for ${slugs.length} client(s) → docs/data/`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
