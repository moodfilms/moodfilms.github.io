// Pulls what is live on GitHub into this folder: docs/data/ (ciphertext, as published) and
// data/<slug>.json + data/<slug>.internal.json (decrypted with the team password), so edits made in
// the browser admin are never overwritten by the next build.
//
//   node scripts/pull.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { b64d, sha, deriveKek, unwrap, decryptJSON } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(path.join(root, "config", "clients.json"), "utf8"));
const hub = cfg.hub || {};
if (!hub.repo) { console.log("No hub.repo in config/clients.json; nothing to pull."); process.exit(0); }
// Read through the GitHub API rather than raw.githubusercontent.com, which caches files for minutes.
import { execSync } from "node:child_process";
let token = process.env.GITHUB_TOKEN || ""; try { token ||= execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const api = `https://api.github.com/repos/${hub.repo}/contents/${hub.dir || "docs/data"}/`;
const get = (file) => fetch(api + file + `?ref=${hub.branch || "main"}`, { headers: { Accept: "application/vnd.github.raw+json", ...(token ? { Authorization: "Bearer " + token } : {}) }, cache: "no-store" });
const out = path.join(root, "docs", "data");

const r = await get("manifest.json");
if (!r.ok) { console.log(`Nothing live yet (${r.status}); skipping pull.`); process.exit(0); }
const m = await r.json();
mkdirSync(out, { recursive: true }); mkdirSync(path.join(root, "data"), { recursive: true });
for (const f of readdirSync(out)) unlinkSync(path.join(out, f));
writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m));
for (const b of Object.values(m.bundles)) writeFileSync(path.join(out, b.file), await (await get(b.file)).text());

const team = m.accounts[await sha("acct:" + cfg.team.username.toLowerCase())];
if (!team) { console.log("Live manifest has no account for the team username in the config; bundles pulled, data not decrypted."); process.exit(0); }
const kek = await deriveKek(process.env.TEAM_OLD_PASSWORD || cfg.team.password, b64d(team.salt), team.iterations);
let n = 0;
for (const [id, w] of Object.entries(team.keys)) {
  let key; try { key = await unwrap(w, kek); } catch { console.error("Team password does not open the live bundles (set TEAM_OLD_PASSWORD if it changed)."); process.exit(1); }
  const b = await decryptJSON(JSON.parse(readFileSync(path.join(out, m.bundles[id].file), "utf8")), key);
  const slug = b.slug, kind = b.kind; delete b.kind;
  const file = path.join(root, "data", kind === "internal" ? `${slug}.internal.json` : `${slug}.json`);
  writeFileSync(file, JSON.stringify(b, null, 2) + "\n"); n++;
}
console.log(`Pulled ${n} bundles from ${hub.repo}; data/ now matches the live site.`);
