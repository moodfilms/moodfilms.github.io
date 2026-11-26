// Pulls a client's project list from its Monday board into data/<slug>.json.
//
//   MONDAY_TOKEN=... node scripts/fetch-monday.mjs            # every client with a board_id
//   node scripts/fetch-monday.mjs --if-configured              # quietly do nothing without a token
//
// The token is read from MONDAY_TOKEN or secrets/monday-token.txt. Columns are matched by
// title (status, department/team, delivery/date, cost/budget, frame/link, summary/notes),
// the same approach as the finance tool. Pinned flags and anything not on the board are kept.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--if-configured");
const tokenFile = path.join(root, "secrets", "monday-token.txt");
const token = process.env.MONDAY_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
const cfg = JSON.parse(readFileSync(path.join(root, "config", "clients.json"), "utf8"));
const targets = cfg.clients.filter((c) => c.monday && c.monday.board_id);

if (!token || targets.length === 0) {
  if (!quiet) console.log(token ? "No client has a monday.board_id set; nothing to fetch." : "No Monday token (MONDAY_TOKEN or secrets/monday-token.txt); nothing fetched.");
  process.exit(0);
}

const HINTS = {
  status: ["status", "stage"], department: ["department", "team", "business line", "division"],
  expected_delivery: ["delivery", "deliver", "due", "deadline", "date"], charge_date: ["charge", "invoice month", "billing"],
  client_cost: ["cost", "price", "budget", "value", "£"], frame_link: ["frame", "draft", "link", "review", "cut"],
  summary: ["summary", "brief", "description", "notes"], next_step: ["next", "action"],
};
const TYPES = { status: ["status"], expected_delivery: ["date", "timeline"], charge_date: ["date"], client_cost: ["numbers", "formula"], frame_link: ["link", "text"] };

async function gql(query, variables) {
  const r = await fetch("https://api.monday.com/v2", { method: "POST", headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-10" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
function guess(columns, saved = {}) {
  const map = { ...saved };
  for (const [field, hints] of Object.entries(HINTS)) {
    if (map[field]) continue;
    const col = columns.find((c) => hints.some((h) => c.title.toLowerCase().includes(h)) && (!TYPES[field] || TYPES[field].includes(c.type)));
    if (col) map[field] = col.id;
  }
  return map;
}
function value(cv) {
  if (!cv) return null;
  if (cv.type === "date" || cv.type === "timeline") { try { const v = JSON.parse(cv.value || "null"); return v?.date || v?.to || cv.text || null; } catch { return cv.text || null; } }
  if (cv.type === "numbers") return cv.text ? Number(String(cv.text).replace(/[^0-9.-]/g, "")) : 0;
  if (cv.type === "link") { try { return JSON.parse(cv.value || "null")?.url || cv.text || ""; } catch { return cv.text || ""; } }
  return cv.text || "";
}

for (const c of targets) {
  const dataPath = path.join(root, c.data);
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const board = (await gql(`query($id:[ID!]){ boards(ids:$id){ name columns{ id title type } items_page(limit:200){ items{ id name group{ title } column_values{ id text type value } } } } }`, { id: [String(c.monday.board_id)] })).boards[0];
  const map = guess(board.columns, c.monday.columns);
  const existing = new Map((data.projects || []).map((p) => [p.monday_item_id || p.id, p]));
  const projects = board.items_page.items.map((it) => {
    const cv = Object.fromEntries(it.column_values.map((v) => [v.id, v]));
    const prev = existing.get(it.id) || {};
    const get = (f) => (map[f] ? value(cv[map[f]]) : prev[f] ?? null);
    return {
      id: prev.id || "md-" + it.id, monday_item_id: it.id, name: it.name,
      department: get("department") || it.group?.title || prev.department || "",
      status: get("status") || prev.status || "Briefing",
      expected_delivery: get("expected_delivery") || prev.expected_delivery || null,
      charge_date: get("charge_date") || get("expected_delivery") || prev.charge_date || null,
      client_cost: Number(get("client_cost") ?? prev.client_cost ?? 0) || 0,
      frame_link: get("frame_link") || prev.frame_link || "",
      summary: get("summary") || prev.summary || "", next_step: get("next_step") || prev.next_step || "",
      deliverables: prev.deliverables || [], pinned: !!prev.pinned,
    };
  });
  // Projects that were on the board before but have gone are kept and parked.
  for (const p of data.projects || []) if (p.monday_item_id && !projects.find((q) => q.monday_item_id === p.monday_item_id)) projects.push({ ...p, status: "On hold" });
  data.projects = projects;
  data.sample = false;
  data.synced_at = new Date().toISOString();
  writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`${c.slug}: ${projects.length} projects from "${board.name}" (columns: ${JSON.stringify(map)})`);
}
