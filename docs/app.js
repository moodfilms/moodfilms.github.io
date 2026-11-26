/* Mood Client Hub — front end.
   Everything shown here is decrypted in the browser with the viewer's passcode; the host only stores
   ciphertext. The team login also carries an admin layer: preview any portal exactly as the client sees
   it, edit what they see, manage logins, and publish straight back to GitHub. */
(() => {
  "use strict";
  const $root = document.getElementById("root");
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
  const money = (v) => gbp.format(Math.round(Number(v) || 0));
  const pct = (v) => Math.round((Number(v) || 0) * 100) + "%";
  const parse = (s) => new Date(String(s).slice(0, 10) + "T00:00:00");
  const fmtDate = (s, opts = { day: "numeric", month: "short", year: "numeric" }) => s ? parse(s).toLocaleDateString("en-GB", opts) : "—";
  const fmtShort = (s) => fmtDate(s, { day: "numeric", month: "short" });
  const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const mkey = (d) => iso(d).slice(0, 7);
  const mlabel = (k) => parse(k + "-01").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }).replace(" ", " ’");
  const isoToday = iso(TODAY);
  const STATUSES = ["Briefing", "Approved", "In creative", "Pre-production", "In production", "In post", "In grade", "Delivered", "On hold"];
  const STAGES = [{ k: "Brief", s: ["Briefing"] }, { k: "Approved", s: ["Approved"] }, { k: "Creative", s: ["In creative"] }, { k: "Pre-production", s: ["Pre-production"] }, { k: "Shoot", s: ["In production"] }, { k: "Edit", s: ["In post"] }, { k: "Grade & finish", s: ["In grade"] }, { k: "Delivered", s: ["Delivered"] }];
  const stageIndex = (status) => STAGES.findIndex((st) => st.s.includes(status));
  const parseLines = (text, sep = "|") => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });
  const daysUntil = (s) => s ? dayDiff(TODAY, parse(s)) : null;
  const DONE = new Set(["Delivered"]);
  const ITERATIONS = 300000;
  const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const dayDiff = (a, b) => Math.round((b - a) / 86400000);
  const h = (strings, ...vals) => strings.reduce((o, s, i) => o + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].join("") : vals[i] ?? "") : ""), "");

  /* ---------------- crypto ---------------- */
  async function sha(text) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24); }
  async function deriveKek(password, salt, iterations = ITERATIONS) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
  }
  const unwrap = (w, kek) => crypto.subtle.unwrapKey("raw", b64d(w.wrapped), kek, { name: "AES-GCM", iv: b64d(w.iv) }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  async function wrap(key, kek) { const iv = crypto.getRandomValues(new Uint8Array(12)); return { iv: b64(iv), wrapped: b64(await crypto.subtle.wrapKey("raw", key, kek, { name: "AES-GCM", iv })) }; }
  const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  async function encryptJSON(obj, key) { const iv = crypto.getRandomValues(new Uint8Array(12)); return { iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)))) }; }
  async function decryptJSON({ iv, ct }, key) { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, key, b64d(ct)))); }
  const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

  /* ---------------- session ---------------- */
  let manifest = null;
  const session = { kind: null, username: "", label: "", kek: null, keys: {}, ids: {}, clients: {}, internal: {}, preview: false };
  async function openBundle(id, key) {
    const r = await fetch("data/" + manifest.bundles[id].file + "?t=" + Date.now(), { cache: "no-store" });
    return decryptJSON(await r.json(), key);
  }
  async function loadBundles(acct, keys, username) {
    session.kind = acct.kind; session.username = username; session.label = acct.kind === "team" ? acct.label || "Mood Studio team" : username;
    session.keys = keys; session.ids = {}; session.clients = {}; session.internal = {};
    for (const [id, key] of Object.entries(keys)) {
      const b = await openBundle(id, key);
      (session.ids[b.slug] ||= {})[b.kind] = id;
      if (b.kind === "internal") session.internal[b.slug] = b; else session.clients[b.slug] = b;
    }
  }
  async function login(username, password) {
    const acct = manifest.accounts[await sha("acct:" + username.trim().toLowerCase())];
    if (!acct) throw new Error("We don't recognise that username.");
    const kek = await deriveKek(password, b64d(acct.salt), acct.iterations);
    const keys = {};
    for (const [id, w] of Object.entries(acct.keys)) { try { keys[id] = await unwrap(w, kek); } catch { throw new Error("That passcode isn't right."); } }
    await loadBundles(acct, keys, username.trim());
    if (acct.kind === "team") session.kek = kek;
    const raw = {}; for (const [id, k] of Object.entries(keys)) raw[id] = b64(await crypto.subtle.exportKey("raw", k));
    try { sessionStorage.setItem("mood-hub", JSON.stringify({ username: username.trim(), raw })); } catch {}
  }
  async function restoreSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem("mood-hub") || "null"); if (!s) return false;
      const acct = manifest.accounts[await sha("acct:" + s.username.toLowerCase())]; if (!acct) return false;
      const keys = {};
      for (const [id, raw] of Object.entries(s.raw)) if (acct.keys[id]) keys[id] = await crypto.subtle.importKey("raw", b64d(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
      await loadBundles(acct, keys, s.username); return true;
    } catch { return false; }
  }
  function logout() { try { sessionStorage.removeItem("mood-hub"); } catch {} location.hash = ""; location.reload(); }
  const isTeam = () => session.kind === "team";
  const clientMode = () => session.kind === "client" || session.preview;

  /* ---------------- GitHub publishing (team only) ---------------- */
  const gh = {
    token: () => { try { return localStorage.getItem("mood-hub-gh") || ""; } catch { return ""; } },
    setToken: (t) => { try { t ? localStorage.setItem("mood-hub-gh", t) : localStorage.removeItem("mood-hub-gh"); } catch {} },
    hub: () => manifest.hub || { repo: "moodfilms/moodfilms.github.io", branch: "main", dir: "docs/data" },
    async api(method, path, body) {
      const r = await fetch("https://api.github.com" + path, { method, headers: { Authorization: "Bearer " + gh.token(), Accept: "application/vnd.github+json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 404 && method === "GET") return null;
      if (!r.ok) throw new Error(`GitHub said ${r.status}: ${(await r.json().catch(() => ({}))).message || r.statusText}`);
      return r.status === 204 ? null : r.json();
    },
    shas: {},
    async put(file, text, message) {
      const { repo, branch, dir } = gh.hub(); const p = `/repos/${repo}/contents/${dir}/${file}`;
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) { delete gh.shas[file]; await new Promise((r) => setTimeout(r, 1500 * attempt)); }
        const sha = gh.shas[file] ?? (await gh.api("GET", p + `?ref=${branch}&t=${Date.now()}`))?.sha;
        try { const r = await gh.api("PUT", p, { message, branch, content: b64(enc.encode(text)), sha }); gh.shas[file] = r?.content?.sha; return r; }
        catch (e) { lastErr = e; if (!/409|422/.test(e.message)) throw e; }
      }
      throw new Error(lastErr.message + " (GitHub was still catching up; try Publish again in a moment)");
    },
    async del(file, message) {
      const { repo, branch, dir } = gh.hub(); const p = `/repos/${repo}/contents/${dir}/${file}`;
      const cur = await gh.api("GET", p + `?ref=${branch}`); if (cur) await gh.api("DELETE", p, { message, branch, sha: cur.sha });
    },
    async freshManifest() {
      const { repo, branch, dir } = gh.hub();
      const cur = await gh.api("GET", `/repos/${repo}/contents/${dir}/manifest.json?ref=${branch}`);
      return cur ? JSON.parse(dec.decode(b64d(cur.content.replace(/\n/g, "")))) : manifest;
    },
    async test() { const { repo } = gh.hub(); const r = await gh.api("GET", `/repos/${repo}`); return r?.permissions?.push ? "ok" : "This token can read the repo but cannot write to it."; },
  };
  async function publishBundle(slug, kind, data) {
    const id = session.ids[slug]?.[kind]; if (!id) throw new Error("No bundle for " + slug);
    const payload = { kind, ...data, slug, updated_at: new Date().toISOString() };
    await gh.put(manifest.bundles[id].file, JSON.stringify(await encryptJSON(payload, session.keys[id])), `Update ${slug} (${kind})`);
    if (kind === "client") session.clients[slug] = payload; else session.internal[slug] = payload;
  }
  async function ensureKek() {
    if (session.kek) return session.kek;
    const pw = await modalPrompt("Confirm your team passcode", "Managing logins needs your team passcode again (it isn't kept after a page refresh).", "password");
    if (pw == null) throw new Error("Cancelled.");
    const acct = manifest.accounts[await sha("acct:" + session.username.toLowerCase())];
    const kek = await deriveKek(pw, b64d(acct.salt), acct.iterations);
    try { await unwrap(Object.values(acct.keys)[0], kek); } catch { throw new Error("That passcode isn't right."); }
    session.kek = kek; return kek;
  }
  async function createClient({ name, slug, username, password, accent, retainer, project }) {
    const kek = await ensureKek();
    const m = await gh.freshManifest();
    const teamId = await sha("acct:" + session.username.toLowerCase());
    if (m.accounts[await sha("acct:" + username.toLowerCase())]) throw new Error("That username is already taken.");
    if (Object.values(session.ids).length && session.ids[slug]) throw new Error("That slug already exists.");
    const clientKey = await newKey(), internalKey = await newKey();
    const clientId = await sha(`bundle:${slug}:client:${randomId()}`), internalId = await sha(`bundle:${slug}:internal:${randomId()}`);
    const data = blankClient({ name, slug, accent, retainer }); if (project) data.projects.push(project);
    const internal = { slug, notes: "", risks: [], projects: {}, invoiced_by_month: {}, paid_by_month: {} };
    await gh.put(clientId + ".enc", JSON.stringify(await encryptJSON({ kind: "client", ...data, updated_at: new Date().toISOString() }, clientKey)), `Add ${slug}`);
    await gh.put(internalId + ".enc", JSON.stringify(await encryptJSON({ kind: "internal", ...internal }, internalKey)), `Add ${slug} (internal)`);
    const salt = crypto.getRandomValues(new Uint8Array(16)); const ckek = await deriveKek(password, salt);
    m.bundles[clientId] = { file: clientId + ".enc" }; m.bundles[internalId] = { file: internalId + ".enc" };
    m.accounts[teamId].keys[clientId] = await wrap(clientKey, kek); m.accounts[teamId].keys[internalId] = await wrap(internalKey, kek);
    m.accounts[await sha("acct:" + username.toLowerCase())] = { kind: "client", slug, salt: b64(salt), iterations: ITERATIONS, keys: { [clientId]: await wrap(clientKey, ckek) } };
    await gh.put("manifest.json", JSON.stringify(m), `Add client ${slug}`);
    manifest = m; session.keys[clientId] = clientKey; session.keys[internalId] = internalKey; session.ids[slug] = { client: clientId, internal: internalId };
    session.clients[slug] = { kind: "client", ...data }; session.internal[slug] = { kind: "internal", ...internal };
    await persistKeys();
  }
  async function setClientLogin(slug, username, password) {
    const m = await gh.freshManifest();
    const clientId = session.ids[slug].client;
    for (const [id, a] of Object.entries(m.accounts)) if (a.kind === "client" && a.keys[clientId]) delete m.accounts[id];
    const acctId = await sha("acct:" + username.toLowerCase());
    if (m.accounts[acctId]) throw new Error("That username is already taken.");
    const salt = crypto.getRandomValues(new Uint8Array(16)); const ckek = await deriveKek(password, salt);
    m.accounts[acctId] = { kind: "client", slug, salt: b64(salt), iterations: ITERATIONS, keys: { [clientId]: await wrap(session.keys[clientId], ckek) } };
    await gh.put("manifest.json", JSON.stringify(m), `Update login for ${slug}`); manifest = m;
  }
  async function removeClient(slug) {
    const m = await gh.freshManifest(); const ids = session.ids[slug];
    for (const [id, a] of Object.entries(m.accounts)) { if (a.kind === "client" && a.keys[ids.client]) delete m.accounts[id]; else { delete a.keys[ids.client]; delete a.keys[ids.internal]; } }
    for (const id of [ids.client, ids.internal]) { if (m.bundles[id]) { await gh.del(m.bundles[id].file, `Remove ${slug}`); delete m.bundles[id]; } }
    await gh.put("manifest.json", JSON.stringify(m), `Remove client ${slug}`); manifest = m;
    delete session.clients[slug]; delete session.internal[slug]; delete session.keys[ids.client]; delete session.keys[ids.internal]; delete session.ids[slug];
    await persistKeys();
  }
  async function persistKeys() { const raw = {}; for (const [id, k] of Object.entries(session.keys)) raw[id] = b64(await crypto.subtle.exportKey("raw", k)); try { sessionStorage.setItem("mood-hub", JSON.stringify({ username: session.username, raw })); } catch {} }
  function blankClient({ name, slug, accent, retainer }) {
    return { slug, sample: false, client: { name, accent: accent || "#2175D9", tagline: retainer ? "Retainer hub" : "Project hub", contact: { name: "", role: "", email: "" }, mood_lead: { name: "Tom Sassi", role: "Producer, Mood Studio", email: "tom@moodfilms.co.uk" }, mood_team: ["Louis Jones", "Tom Sassi", "Jeanine Guerida"] },
      show: { money: !!retainer, projects: true, library: true, brief: true, updates: true, team: true },
      retainer: retainer ? { name: `${name} × Mood retainer`, start_date: retainer.start_date, initial_months: +retainer.initial_months || 3, extension_months: +retainer.extension_months || 0, extension_status: +retainer.extension_months ? "option" : "none", monthly_value: +retainer.monthly_value || 0, carry_over_months: 1, terms: "" } : null,
      payments: [], projects: [], library: [], briefing: { form_url: "", send_to: "hello@moodfilms.co.uk", turnaround: "Options, a quote and a timeline within two working days", formats: [] }, updates: [] };
  }

  /* ---------------- retainer maths (mirrors finance/retainers.py) ---------------- */
  const addMonths = (d, n) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
  function timeline(r) {
    const start = parse(r.start_date);
    const initialEnd = addMonths(start, +r.initial_months); initialEnd.setDate(0);
    const extMonths = +r.extension_months || 0, status = extMonths ? (r.extension_status || "option") : "none";
    const extStart = new Date(initialEnd); extStart.setDate(extStart.getDate() + 1);
    const extEnd = addMonths(extStart, extMonths); extEnd.setDate(0);
    const contractEnd = status === "taken" ? extEnd : initialEnd;
    const seg = (a, b) => { const total = Math.max(0, dayDiff(a, b) + 1); const done = Math.min(Math.max(dayDiff(a, TODAY) + 1, 0), total); return { start: a, end: b, days: total, days_done: done, days_left: total - done, pct: total ? done / total : 0 }; };
    const phase = TODAY < start ? "before start" : TODAY <= initialEnd ? "initial term" : status === "taken" && TODAY <= extEnd ? "extension" : "ended";
    const decisionBy = new Date(initialEnd); decisionBy.setDate(decisionBy.getDate() - 30);
    return { start, initialEnd, extStart, extEnd, contractEnd, status, extMonths, phase, initial: seg(start, initialEnd), extension: extMonths ? seg(extStart, extEnd) : { days: 0 }, contract: seg(start, contractEnd), decisionBy: status === "option" ? decisionBy : null, monthsTotal: +r.initial_months + (status === "taken" ? extMonths : 0) };
  }
  function contractMonths(r, includeOption) {
    const start = parse(r.start_date); let n = +r.initial_months; const ext = +r.extension_months || 0, st = ext ? (r.extension_status || "option") : "none";
    if (st === "taken" || (includeOption && st === "option")) n += ext;
    return Array.from({ length: n }, (_, i) => mkey(addMonths(start, i)));
  }
  const chargeMonth = (p) => (p.charge_date || p.expected_delivery || "").slice(0, 7) || null;
  function computeMoney(r, projects, internal) {
    const base = +r.monthly_value || 0, carryMonths = +(r.carry_over_months ?? 1), tl = timeline(r);
    const months = contractMonths(r, true), firm = new Set(contractMonths(r, false));
    const usedBy = {}, projBy = {};
    for (const p of projects) { const m = chargeMonth(p); if (!m) continue; usedBy[m] = (usedBy[m] || 0) + (+p.client_cost || 0); (projBy[m] ||= []).push(p); }
    const unallocated = projects.filter((p) => !chargeMonth(p)).reduce((s, p) => s + (+p.client_cost || 0), 0);
    const rows = []; let queue = []; const thisMonth = mkey(TODAY);
    const paid = internal?.paid_by_month || {}, invoiced = internal?.invoiced_by_month || {};
    for (const m of months) {
      const used = usedBy[m] || 0, carryIn = queue.reduce((a, b) => a + b, 0), allowance = base + carryIn;
      const within = Math.min(used, allowance), overage = Math.max(0, used - allowance);
      const fromCarry = Math.min(used, carryIn), fromBase = Math.min(Math.max(0, used - carryIn), base), unusedOwn = base - fromBase;
      rows.push({ month: m, label: mlabel(m), firm: firm.has(m), state: m < thisMonth ? "past" : m === thisMonth ? "current" : "future", base, carry_in: carryIn, allowance, used, within, overage, unused: unusedOwn, from_carry: fromCarry, expired: carryIn - fromCarry, paid: paid[m] || 0, invoiced: invoiced[m] || 0, projects: projBy[m] || [] });
      queue.push(unusedOwn); queue = queue.slice(-carryMonths);
    }
    const firmRows = rows.filter((x) => x.firm), elapsed = firmRows.filter((x) => x.state !== "future");
    const contractValue = base * firmRows.length, withinTotal = firmRows.reduce((s, x) => s + x.within, 0), current = rows.find((x) => x.state === "current");
    return { base, carryMonths, contractValue, contractValueWithOption: base * rows.length, used: rows.reduce((s, x) => s + x.used, 0), within: withinTotal, overage: rows.reduce((s, x) => s + x.overage, 0), remaining: contractValue - withinTotal, released: base * elapsed.length, availableNow: current ? current.allowance - current.used : 0, current, expired: rows.filter((x) => x.state === "past").reduce((s, x) => s + x.expired, 0), unallocated, rows, tl, pctUsed: contractValue ? withinTotal / contractValue : 0, pctTime: tl.contract.pct, paid: Object.values(paid).reduce((a, b) => a + b, 0), invoiced: Object.values(invoiced).reduce((a, b) => a + b, 0) };
  }
  function health(m) {
    if (!m) return { k: "neutral", t: "Projects" };
    if (m.tl.phase === "before start") return { k: "neutral", t: "Starts " + fmtShort(iso(m.tl.start)) };
    if (m.tl.phase === "ended") return { k: "neutral", t: "Ended" };
    const share = m.contractValue ? m.used / m.contractValue : 0;
    if (m.overage > 0) return { k: "bad", t: "Over allowance" };
    if (share > m.pctTime + 0.25) return { k: "warn", t: "Ahead of pace" };
    if (share < m.pctTime - 0.25) return { k: "warn", t: "Under-used" };
    return { k: "good", t: "On track" };
  }

  /* ---------------- components ---------------- */
  const pill = (s) => `<span class="pill" data-s="${esc(s)}">${esc(s)}</span>`;
  const stat = (label, value, foot = "", cls = "") => `<div class="card ${cls}"><div class="stat"><span class="stat__label">${label}</span><span class="stat__value">${value}</span>${foot ? `<span class="stat__foot">${foot}</span>` : ""}</div></div>`;
  const warnIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`;
  const extIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>`;

  function timelineHTML(tl, r) {
    const totalDays = tl.initial.days + tl.extension.days;
    const iw = (tl.initial.days / totalDays) * 100, ew = 100 - iw;
    const doneW = Math.min(100, Math.max(0, ((dayDiff(tl.start, TODAY) + 1) / totalDays) * 100));
    const todayPos = Math.min(100, Math.max(0, ((dayDiff(tl.start, TODAY) + 0.5) / totalDays) * 100));
    const decPos = tl.decisionBy ? ((dayDiff(tl.start, tl.decisionBy) + 0.5) / totalDays) * 100 : null;
    const monthsAll = contractMonths(r, true);
    const extLabel = tl.status === "taken" ? "Extension · confirmed" : tl.status === "declined" ? "Extension · not taken" : `Extension · ${tl.extMonths}-month option`;
    return h`<div class="timeline">
      <div class="timeline__track">
        <div class="timeline__seg timeline__seg--initial" style="width:${iw}%;${tl.extMonths ? "" : "border-radius:999px"}"><span class="timeline__seglabel">${tl.extMonths ? `Initial term · ${r.initial_months} months` : `${r.initial_months}-month term · ${fmtShort(iso(tl.start))} to ${fmtShort(iso(tl.initialEnd))}`}</span></div>
        ${tl.extMonths ? `<div class="timeline__seg timeline__seg--ext ${tl.status}" style="width:${ew}%"><span class="timeline__seglabel">${extLabel}</span></div>` : ""}
        ${doneW > 0 && tl.phase !== "before start" ? `<div class="timeline__done" style="width:${Math.min(doneW, tl.status === "taken" ? 100 : iw)}%;${!tl.extMonths && doneW >= 100 ? "border-radius:999px" : ""}"></div>` : ""}
        ${decPos !== null && tl.phase !== "ended" ? `<div class="timeline__mark" style="left:${decPos}%" data-label="Decide by ${fmtShort(iso(tl.decisionBy))}"></div>` : ""}
        ${tl.phase !== "ended" && tl.phase !== "before start" ? `<div class="timeline__today" style="left:${todayPos}%" data-label="Today"></div>` : ""}
      </div>
      <div class="timeline__dates"><span>${fmtDate(iso(tl.start))}</span>${tl.extMonths ? `<span>${fmtDate(iso(tl.initialEnd))}</span><span>${fmtDate(iso(tl.extEnd))}</span>` : `<span>${fmtDate(iso(tl.initialEnd))}</span>`}</div>
      <div class="timeline__months">${monthsAll.map((m) => `<span>${mlabel(m)}</span>`)}</div>
    </div>
    <div class="timeline__legend"><span>■ ${tl.extMonths ? `Initial · ${r.initial_months} mo` : `${r.initial_months}-month term`}</span>${tl.extMonths ? `<span>▨ ${extLabel.replace("Extension · ", "Ext. ")}</span>` : ""}${tl.decisionBy ? `<span style="color:var(--warn)">| Decide by ${fmtShort(iso(tl.decisionBy))}</span>` : ""}</div>`;
  }
  function moneyChart(m) {
    const rows = m.rows, W = 760, H = 260, padL = 54, padR = 12, padT = 28, padB = 36, innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(...rows.map((r) => Math.max(r.allowance, r.used)), m.base, 1) * 1.15;
    const y = (v) => padT + innerH - (v / max) * innerH, slot = innerW / rows.length, bw = Math.min(56, slot * 0.58);
    let grid = ""; for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; grid += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? "£" + Math.round(v / 1000) + "k" : "£" + Math.round(v)}</text>`; }
    let bars = "";
    rows.forEach((r, i) => {
      const x = padL + slot * i + (slot - bw) / 2, top = y(r.allowance), base = y(0);
      bars += `<rect class="bar-track ${r.firm ? "" : "option"}" x="${x}" y="${top}" width="${bw}" height="${Math.max(0, base - top)}" rx="4"/>`;
      if (r.used > 0) {
        const within = Math.min(r.used, r.allowance), fromCarry = Math.min(within, r.carry_in), fromBase = within - fromCarry, yWithin = y(within);
        if (fromBase > 0) bars += `<rect class="bar-used" x="${x}" y="${y(fromBase)}" width="${bw}" height="${Math.max(0, base - y(fromBase))}" rx="4"/>`;
        if (fromCarry > 0) bars += `<rect class="bar-carry" x="${x}" y="${yWithin}" width="${bw}" height="${Math.max(0, y(fromBase) - yWithin - (fromBase > 0 ? 2 : 0))}" rx="4"/>`;
        if (r.overage > 0) { const yo = y(r.used); bars += `<rect class="bar-over" x="${x}" y="${yo}" width="${bw}" height="${Math.max(0, y(r.allowance) - yo - 2)}" rx="4"/><text class="label over" x="${x + bw / 2}" y="${yo - 6}" text-anchor="middle">+${money(r.overage)}</text>`; }
        else bars += `<text class="label" x="${x + bw / 2}" y="${Math.min(yWithin, top) - 6}" text-anchor="middle">${money(r.used)}</text>`;
      } else bars += `<text class="label" style="fill:var(--txt-3)" x="${x + bw / 2}" y="${top - 6}" text-anchor="middle">${money(r.allowance)}</text>`;
      bars += `<text class="axis" x="${x + bw / 2}" y="${H - 12}" text-anchor="middle">${r.label}</text>`;
      if (r.state === "current") bars += `<rect class="current-pill" x="${x + bw / 2 - 26}" y="${padT - 26}" width="52" height="16" rx="8"/><text class="current-text" x="${x + bw / 2}" y="${padT - 14.5}" text-anchor="middle">NOW</text>`;
      bars += `<rect class="hit" data-i="${i}" x="${padL + slot * i}" y="${padT - 28}" width="${slot}" height="${innerH + 28}"/>`;
    });
    return `<div class="chart" id="money-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Allowance and work charged by month">${grid}<line class="baseline" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>${bars}</svg><div class="tooltip" id="money-tip"></div></div>
      <div class="legend"><span><i class="track"></i>Allowance (incl. carry-over)</span>${rows.some((r) => !r.firm) ? `<span><i class="option"></i>Option months, not yet firm</span>` : ""}<span><i class="used"></i>Work charged</span><span><i class="carry"></i>Paid from carry-over</span><span><i class="over"></i>Over allowance, billed on top</span></div>`;
  }
  function wireChart(m) {
    const chart = document.getElementById("money-chart"); if (!chart) return; const tip = document.getElementById("money-tip");
    chart.querySelectorAll(".hit").forEach((el) => {
      el.addEventListener("mouseenter", () => { const r = m.rows[+el.dataset.i];
        tip.innerHTML = `<b>${esc(parse(r.month + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" }))}${r.firm ? "" : " · option"}</b><div class="row"><span>Monthly value</span><em>${money(r.base)}</em></div><div class="row"><span>Carried in</span><em>${money(r.carry_in)}</em></div><div class="row"><span>Allowance</span><em>${money(r.allowance)}</em></div><div class="row"><span>Work charged</span><em>${money(r.used)}</em></div>${r.overage ? `<div class="row"><span>Over allowance</span><em>${money(r.overage)}</em></div>` : `<div class="row"><span>Unused → next month</span><em>${money(r.unused)}</em></div>`}${r.projects.length ? `<div class="row" style="margin-top:6px;color:rgba(255,255,255,.55)"><span>${r.projects.map((p) => esc(p.name)).join("<br>")}</span></div>` : ""}`;
        tip.classList.add("show"); });
      el.addEventListener("mousemove", (e) => { const b = chart.getBoundingClientRect(); tip.style.left = (e.clientX - b.left) + "px"; tip.style.top = Math.max(0, e.clientY - b.top - tip.offsetHeight - 14) + "px"; });
      el.addEventListener("mouseleave", () => tip.classList.remove("show"));
    });
  }
  function moneyTable(m) {
    return h`<div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Monthly value</th><th class="num">Carried in</th><th class="num">Allowance</th><th class="num">Work charged</th><th class="num">Over allowance</th><th class="num">Carries forward</th><th>Projects</th></tr></thead>
      <tbody>${m.rows.map((r) => `<tr class="${r.state} ${r.firm ? "" : "option"}"><td><b>${r.label}</b>${r.firm ? "" : '<div class="sub">Option</div>'}${r.state === "current" ? '<div class="sub">This month</div>' : ""}</td><td class="num">${money(r.base)}</td><td class="num">${money(r.carry_in)}</td><td class="num"><b>${money(r.allowance)}</b></td><td class="num">${money(r.used)}</td><td class="num">${r.overage ? `<span class="delta delta--bad">${money(r.overage)}</span>` : "—"}</td><td class="num">${money(r.unused)}</td><td>${r.projects.map((p) => esc(p.name)).join("<br>") || "—"}</td></tr>`)}</tbody>
      <tfoot><tr><td>Firm contract</td><td class="num">${money(m.contractValue)}</td><td></td><td></td><td class="num">${money(m.used)}</td><td class="num">${m.overage ? money(m.overage) : "—"}</td><td class="num">${money(m.remaining)} left</td><td></td></tr></tfoot></table></div>`;
  }
  function projectCard(p) {
    return h`<article class="card pcard">${p.pinned ? `<span class="pin" title="Pinned"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3l5 5-4 1-3.5 3.5.5 5.5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5.5.5L14 7z"/></svg></span>` : ""}
      <div class="pcard__top">${pill(p.status)}<span class="pcard__dept">${esc(p.department || "")}</span></div><h3><a class="plain" href="#/c/${esc(p.__slug)}/p/${esc(p.id)}">${esc(p.name)}</a></h3>
      ${p.summary ? `<p class="pcard__sum">${esc(p.summary)}</p>` : ""}${p.deliverables?.length ? `<div class="tags">${p.deliverables.map((d) => `<span class="tag">${esc(d)}</span>`).join("")}</div>` : ""}
      <div class="pcard__meta"><div><span>Expected delivery</span><b>${fmtDate(p.expected_delivery)}</b></div><div><span>${p.__ret ? "Cost to retainer" : "Cost"}</span><b>${p.client_cost ? money(p.client_cost) : "TBC"}</b></div></div>
      ${p.next_step ? `<p class="pcard__next">${esc(p.next_step)}</p>` : ""}
      <div class="pcard__actions"><a class="btn btn--ink btn--sm" href="#/c/${esc(p.__slug)}/p/${esc(p.id)}">Full rundown →</a>${p.frame_link ? `<a class="btn btn--ghost btn--sm" href="${esc(p.frame_link)}" target="_blank" rel="noopener">Latest draft ${extIcon}</a>` : ""}</div></article>`;
  }
  function modalPrompt(title, text, type = "text", placeholder = "") {
    return new Promise((resolve) => {
      const el = document.createElement("div"); el.className = "modal-bg";
      el.innerHTML = `<form class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="f"><input type="${type}" placeholder="${esc(placeholder)}" autofocus></div><div class="acts"><button type="button" class="btn btn--ghost btn--sm" data-x>Cancel</button><button class="btn btn--ink btn--sm">Continue</button></div></form>`;
      document.body.appendChild(el); const inp = el.querySelector("input"); setTimeout(() => inp.focus(), 30);
      el.querySelector("[data-x]").onclick = () => { el.remove(); resolve(null); };
      el.querySelector("form").onsubmit = (e) => { e.preventDefault(); const v = inp.value; el.remove(); resolve(v); };
    });
  }
  function confirmModal(title, text, verb = "Confirm") {
    return new Promise((resolve) => {
      const el = document.createElement("div"); el.className = "modal-bg";
      el.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="acts"><button class="btn btn--ghost btn--sm" data-x>Cancel</button><button class="btn btn--sm btn--danger" data-ok>${esc(verb)}</button></div></div>`;
      document.body.appendChild(el); el.querySelector("[data-x]").onclick = () => { el.remove(); resolve(false); }; el.querySelector("[data-ok]").onclick = () => { el.remove(); resolve(true); };
    });
  }

  /* ---------------- shell ---------------- */
  function renderGate(error = "") {
    $root.innerHTML = h`<div class="gate"><section class="gate__brand"><img class="gate__logo" src="assets/logo/mood-white.png" alt="Mood Studio">
      <div><h1 class="gate__headline">Your films, <em>your numbers,</em> one place.</h1><p class="gate__sub">Live project status, retainer allowance and every delivered film for your team. Sign in with the details Mood Studio sent you.</p></div>
      <div class="gate__foot"><span>Mood Studio</span><span>Leeds &amp; London</span><span>moodstudio.co</span></div></section>
      <section class="gate__form"><form class="gate__card fade-in" id="login" autocomplete="on"><span class="eyebrow">Client hub</span><h2>Sign in</h2>
        <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
        <div class="field"><label for="p">Passcode</label><div class="pwwrap"><input id="p" name="password" type="password" autocomplete="current-password" required><button type="button" id="toggle-pw">Show</button></div></div>
        <div class="gate__error" id="err">${esc(error)}</div><button class="btn btn--lime btn--block" id="go" type="submit">Open dashboard</button>
        <p class="gate__hint">Lost your passcode? Email <a href="mailto:hello@moodfilms.co.uk" style="color:#fff">hello@moodfilms.co.uk</a>.</p></form></section></div>`;
    document.getElementById("toggle-pw").onclick = (e) => { const i = document.getElementById("p"); i.type = i.type === "password" ? "text" : "password"; e.target.textContent = i.type === "password" ? "Show" : "Hide"; };
    document.getElementById("login").onsubmit = async (e) => { e.preventDefault(); const btn = document.getElementById("go"), err = document.getElementById("err"); btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
      try { await login(e.target.username.value, e.target.password.value); route(); } catch (ex) { err.textContent = ex.message || "Could not sign in."; btn.disabled = false; btn.textContent = "Open dashboard"; } };
    setTimeout(() => document.getElementById("u")?.focus(), 50);
  }
  function shell(inner, { client = null, tabs = [], active = "" } = {}) {
    const accent = client?.client?.accent || "#2175D9";
    document.documentElement.style.setProperty("--accent", accent); document.documentElement.style.setProperty("--accent-soft", accent + "1f");
    const cm = clientMode();
    $root.innerHTML = h`<div class="app">
      ${session.preview ? `<div class="previewbar"><div class="previewbar__in"><span>Previewing as ${esc(client?.client?.name || "the client")} · exactly what they see</span><span class="spacer"></span><button id="exit-preview">Exit preview</button></div></div>` : ""}
      <header class="topbar"><div class="topbar__in">
        <a href="${cm ? "#/c/" + (client?.slug || "") : "#/"}" title="Mood Studio"><img class="topbar__logo" src="assets/logo/mood-white.png" alt="Mood Studio"></a>
        ${client ? `<span class="topbar__sep"></span><span class="topbar__client"><i class="dot"></i>${esc(client.client.name)}<span class="faint" style="font-weight:600">· ${esc(client.client.tagline || "Client hub")}</span></span>` : ""}
        <span class="topbar__spacer"></span>
        <span class="topbar__actions">${!cm ? `<span class="chip chip--lime">Team view</span>` : ""}${client && isTeam() && !session.preview ? `<button class="btn btn--preview" id="start-preview">View as client</button>` : ""}</span>
        ${!session.preview ? `<span class="topbar__user">Signed in as <b>${esc(session.label)}</b><button class="linkbtn" id="logout">Sign out</button></span>` : ""}
      </div>
      ${tabs.length ? `<nav class="subnav"><div class="subnav__in" role="tablist">${tabs.map((t) => `<button class="tab ${t.cls || ""}" role="tab" aria-selected="${t.id === active}" data-href="${t.href}">${t.label}${t.count != null ? `<span class="count">${t.count}</span>` : ""}</button>`).join("")}</div></nav>` : ""}</header>
      <main class="main fade-in">${inner}</main>
      <footer class="footer"><span>Mood Studio Limited · hello@moodfilms.co.uk · Leeds &amp; London</span><span>${client?.updated_at ? "Updated " + esc(fmtDate(client.updated_at.slice(0, 10))) : ""}${client?.synced_at ? " · synced from Monday " + esc(fmtDate(client.synced_at.slice(0, 10))) : ""}</span></footer></div>`;
    document.getElementById("logout")?.addEventListener("click", logout);
    document.getElementById("start-preview")?.addEventListener("click", () => { session.preview = true; route(); });
    document.getElementById("exit-preview")?.addEventListener("click", () => { session.preview = false; route(); });
    $root.querySelectorAll(".tab").forEach((b) => (b.onclick = () => (location.hash = b.dataset.href)));
  }

  /* ---------------- portfolio ---------------- */
  function renderPortfolio() {
    const slugs = Object.keys(session.clients).sort();
    const rows = slugs.map((slug) => { const c = session.clients[slug]; const m = c.retainer ? computeMoney(c.retainer, c.projects || [], session.internal[slug]) : null; return { slug, c, m, hl: health(m), live: (c.projects || []).filter((p) => !DONE.has(p.status)).length }; });
    const totals = rows.reduce((t, r) => { t.contract += r.m?.contractValue || 0; t.used += r.m?.used || 0; t.live += r.live; t.retainers += r.m ? 1 : 0; return t; }, { contract: 0, used: 0, live: 0, retainers: 0 });
    const month = isoToday.slice(0, 7), dueMonth = rows.reduce((n, r) => n + (r.c.projects || []).filter((p) => !DONE.has(p.status) && (p.expected_delivery || "").startsWith(month)).length, 0);
    shell(h`<div class="page-head"><div><span class="eyebrow">Mood Studio · internal</span><h1>Client dashboards</h1><p class="lead">Every client hub in one place. Open one to see it as the client does, edit what they see, or check the internal numbers.</p></div>
      <div class="page-head__actions"><a class="btn btn--ghost" href="#/projects">All projects</a><a class="btn btn--ink" href="#/admin/new">+ Add a client</a></div></div>
      <div class="grid grid--4" style="margin-bottom:28px">${stat("Clients", slugs.length, `${totals.retainers} on retainer`, "card--ink")}${stat("Live projects", totals.live, `<a href="#/projects" style="color:inherit">${dueMonth} due this month →</a>`)}${stat("Retainer value", money(totals.contract), "firm months across all retainers")}${stat("Committed", money(totals.used), "work charged to allowances")}</div>
      <div class="section"><div class="section__head"><div><span class="eyebrow">Portals</span><h2>Clients</h2></div></div>
      <div class="pf">${rows.map(({ slug, c, m, hl, live }) => `<button class="pfcard" data-slug="${slug}" style="--accent:${esc(c.client.accent || "#2175D9")}">
        <div class="pfcard__top"><span class="pfcard__name"><i class="dot"></i>${esc(c.client.name)}</span><span class="health health--${hl.k}">${hl.t}</span></div>
        ${m ? `<div><div class="meter"><i style="width:${Math.min(100, m.contractValue ? (m.used / m.contractValue) * 100 : 0)}%"></i></div><div class="meter-row"><span>${money(m.used)} committed of ${money(m.contractValue)}</span><span>${pct(m.pctTime)} of term</span></div></div>
        <div class="pfcard__stats"><div><span>Phase</span><b style="font-size:14px;text-transform:capitalize">${m.tl.phase}</b></div><div><span>Live projects</span><b>${live}</b></div><div><span>Available now</span><b>${money(Math.max(0, m.availableNow))}</b></div></div>` : `<div class="pfcard__stats"><div><span>Type</span><b style="font-size:14px">Project work</b></div><div><span>Live projects</span><b>${live}</b></div><div><span>Next delivery</span><b style="font-size:14px">${(() => { const n = (c.projects || []).filter((p) => !DONE.has(p.status) && p.expected_delivery).sort((a, b) => a.expected_delivery.localeCompare(b.expected_delivery))[0]; return n ? fmtShort(n.expected_delivery) : "—"; })()}</b></div></div>`}
        ${c.sample ? `<span class="chip chip--warn" style="align-self:flex-start">Sample figures</span>` : ""}</button>`)}
      <a class="pfcard pfcard--add" href="#/admin/new" style="text-decoration:none">+ Add a client</a></div></div>`, { tabs: teamTabs("clients"), active: "clients" });
    $root.querySelectorAll(".pfcard[data-slug]").forEach((b) => (b.onclick = () => (location.hash = "#/c/" + b.dataset.slug)));
  }

  function portalTabs(slug, c, team) {
    const show = c.show || {}, projects = c.projects || [], live = projects.filter((p) => !DONE.has(p.status)).length, delivered = projects.length - live;
    const tabs = [{ id: "overview", label: "Overview", href: `#/c/${slug}` }];
    if (show.money && c.retainer) tabs.push({ id: "money", label: "Retainer & money", href: `#/c/${slug}/money` });
    if (show.projects) tabs.push({ id: "projects", label: "Projects", href: `#/c/${slug}/projects`, count: live });
    if (show.library) tabs.push({ id: "library", label: "Delivered films", href: `#/c/${slug}/library`, count: (c.library?.length || 0) + delivered });
    if (show.brief) tabs.push({ id: "brief", label: "Brief a film", href: `#/c/${slug}/brief` });
    if (team) tabs.push({ id: "internal", label: "Internal", href: `#/c/${slug}/internal`, cls: "tab--internal" }, { id: "admin", label: "Edit this hub", href: `#/c/${slug}/admin`, cls: "tab--admin" });
    return tabs;
  }
  /* ---------------- client portal ---------------- */
  function renderClient(slug, tab = "overview", pid) {
    const c = session.clients[slug]; if (!c) { location.hash = "#/"; return; }
    c.show ||= { money: !!c.retainer, projects: true, library: true, brief: true, updates: true, team: true };
    const team = isTeam() && !session.preview, internal = isTeam() ? session.internal[slug] : null;
    const m = c.retainer ? computeMoney(c.retainer, c.projects || [], internal) : null, tl = m?.tl, hl = health(m);
    const projects = (c.projects || []).map((p) => Object.assign(p, { __slug: slug, __ret: !!c.retainer })), live = projects.filter((p) => !DONE.has(p.status)), delivered = projects.filter((p) => DONE.has(p.status));
    const tabs = portalTabs(slug, c, team);
    if (tab === "p") { renderProject(slug, arguments[2], team); return; }
    if (!tabs.find((t) => t.id === tab)) tab = "overview";
    const sampleBanner = c.sample ? `<div class="banner">${warnIcon}<span>Sample figures: placeholders until the real scope is entered${team ? ` in <a href="#/c/${slug}/admin">Edit this hub</a>` : ""}.</span></div>` : "";
    const backLink = team ? `<a class="btn btn--ghost btn--sm" href="#/">← All clients</a>` : "";
    const lead = c.client.mood_lead || {};
    let body = "";
    if (tab === "overview") {
      const pinned = live.filter((p) => p.pinned), rest = live.filter((p) => !p.pinned).sort((a, b) => (a.expected_delivery || "9999").localeCompare(b.expected_delivery || "9999")), top = [...pinned, ...rest].slice(0, 3);
      const next = live.filter((p) => p.expected_delivery && p.expected_delivery >= isoToday).sort((a, b) => a.expected_delivery.localeCompare(b.expected_delivery))[0];
      const intro = !m ? `${live.length} project${live.length === 1 ? "" : "s"} in flight with Mood.` : tl.phase === "before start" ? `Your retainer starts on ${fmtDate(iso(tl.start))}.` : tl.phase === "ended" ? "This retainer has ended. Everything delivered is in the library." : `You are ${tl.contract.days_done} days into your ${tl.monthsTotal}-month retainer with ${live.length} project${live.length === 1 ? "" : "s"} in flight.`;
      body = h`${sampleBanner}<div class="page-head"><div><span class="eyebrow">${esc(c.retainer?.name || c.client.tagline || "Client hub")}</span><h1>Hello, ${esc(c.client.name)}.</h1><p class="lead">${intro}</p></div>
        <div class="page-head__actions">${backLink}${c.show.brief ? `<a class="btn btn--ink" href="#/c/${slug}/brief">Brief a new film</a>` : ""}</div></div>
      <div class="grid grid--4">
        ${m ? (m.current ? stat("Available this month", money(Math.max(0, m.availableNow)), `${money(m.current.carry_in)} carried in · <span class="delta delta--${m.current.overage ? "bad" : "good"}">${m.current.overage ? "Over by " + money(m.current.overage) : money(m.current.used) + " charged"}</span>`, "card--ink") : tl.phase === "before start" ? stat("First month's allowance", money(m.rows[0]?.allowance || m.base), `from ${fmtDate(iso(tl.start))}`, "card--ink") : stat("Retainer", money(m.contractValue), "contract value", "card--ink")) : stat("Live projects", live.length, `${delivered.length} delivered`, "card--ink")}
        ${m ? stat("Committed to date", money(m.used), `<span class="delta delta--${hl.k}">${hl.t}</span> · ${pct(m.contractValue ? m.used / m.contractValue : 0)} of ${money(m.contractValue)}`) : stat("Delivered", delivered.length, "films completed")}
        ${m ? stat("Live projects", live.length, `${delivered.length} delivered under this retainer`) : stat("In production", live.filter((p) => /production|post|grade/i.test(p.status)).length, "being shot or cut")}
        ${stat("Next delivery", next ? fmtShort(next.expected_delivery) : "—", next ? esc(next.name) : "Nothing scheduled yet")}</div>
      ${m ? h`<div class="grid grid--main section">
        <section class="card"><div class="card__head"><h2>Contract timeline</h2><span class="phase"><i></i>${tl.phase[0].toUpperCase() + tl.phase.slice(1)}</span></div>${timelineHTML(tl, c.retainer)}
          <dl class="kv" style="margin-top:36px"><dt>Monthly value</dt><dd>${money(m.base)}</dd><dt>${tl.extMonths ? "Firm contract" : "Contract value"}</dt><dd>${money(m.contractValue)} · ${c.retainer.initial_months} months</dd>${tl.extMonths ? `<dt>If the option is taken</dt><dd>${money(m.contractValueWithOption)} · ${+c.retainer.initial_months + tl.extMonths} months</dd>` : ""}${tl.decisionBy ? `<dt>Extension decision by</dt><dd>${fmtDate(iso(tl.decisionBy))}</dd>` : ""}</dl></section>
        <section class="card"><div class="card__head"><h2>How the allowance works</h2></div>
          <div class="steps"><div class="step"><div><b>${money(m.base)} a month</b>to spend on films, in any mix of projects.</div></div><div class="step"><div><b>Unused money rolls into the next month</b>then expires, so a quiet month can fund a bigger one.</div></div><div class="step"><div><b>Anything over the allowance is agreed first</b>and billed on top, never a surprise.</div></div></div>
          ${c.retainer.terms ? `<p class="muted" style="margin-top:18px;font-size:13px">${esc(c.retainer.terms)}</p>` : ""}</section></div>` : ""}
      ${c.show.projects ? h`<div class="section"><div class="section__head"><div><span class="eyebrow">In flight</span><h2>Where your projects are</h2></div><a class="btn btn--ghost btn--sm" href="#/c/${slug}/projects">All projects →</a></div>
        ${top.length ? `<div class="grid grid--3">${top.map(projectCard).join("")}</div>` : `<div class="empty">No live projects yet. ${c.show.brief ? `<a href="#/c/${slug}/brief">Brief one</a> and it appears here.` : "Projects appear here as they are briefed."}</div>`}</div>` : ""}
      <div class="grid grid--2 section">
        ${c.show.updates ? `<section class="card"><div class="card__head"><h2>Latest from Mood</h2></div>${c.updates?.length ? `<div class="feed">${c.updates.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((u) => `<div class="feed__item"><time>${fmtShort(u.date)}</time><p>${esc(u.text)}</p></div>`).join("")}</div>` : `<div class="empty">Updates will appear here.</div>`}</section>` : ""}
        ${c.show.team ? `<section class="card"><div class="card__head"><h2>Your team at Mood</h2></div><dl class="kv"><dt>Your producer</dt><dd>${esc(lead.name || "Mood Studio")}</dd><dt>Email</dt><dd><a href="mailto:${esc(lead.email || "hello@moodfilms.co.uk")}">${esc(lead.email || "hello@moodfilms.co.uk")}</a></dd><dt>Working on your account</dt><dd>${(c.client.mood_team || []).map(esc).join(", ")}</dd><dt>Response time</dt><dd>${esc(c.briefing?.turnaround || "Two working days")}</dd></dl>
          <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn btn--ink btn--sm" href="mailto:${esc(lead.email || "hello@moodfilms.co.uk")}">Email ${esc((lead.name || "Mood").split(" ")[0])}</a>${c.show.brief ? `<a class="btn btn--ghost btn--sm" href="#/c/${slug}/brief">Brief a film</a>` : ""}</div></section>` : ""}</div>`;
    }
    if (tab === "money") {
      const pays = c.payments || [], payTotal = pays.reduce((s, p) => s + (+p.amount || 0), 0);
      body = h`${sampleBanner}<div class="page-head"><div><span class="eyebrow">${esc(c.retainer.name)}</span><h1>Retainer &amp; money</h1><p class="lead">Month by month: what the allowance is, what has been charged against it, and what carries forward.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="grid grid--4">${stat(tl.extMonths ? "Firm contract" : "Contract value", money(m.contractValue), `${money(m.base)} × ${c.retainer.initial_months} months`, "card--ink")}${stat("Committed", money(m.used), `${money(m.remaining)} still to use`)}${stat("Carried over", money(m.current?.carry_in || 0), m.current ? "into this month" : "—")}${stat("Over allowance", money(m.overage), m.overage ? `<span class="delta delta--bad">Billed on top</span>` : `<span class="delta delta--good">Nothing extra to bill</span>`)}</div>
      <section class="card section"><div class="card__head"><div><span class="eyebrow">Allowance vs work charged</span><h2>By month</h2></div><span class="faint" style="font-size:13px">Hover a month for the breakdown</span></div>${moneyChart(m)}</section>
      <section class="card section"><div class="card__head"><h2>The ledger</h2>${m.unallocated ? `<span class="chip chip--warn">${money(m.unallocated)} not yet dated</span>` : ""}</div>${moneyTable(m)}</section>
      ${pays.length ? `<section class="card section"><div class="card__head"><div><span class="eyebrow">What ${esc(c.client.name)} pays, and when</span><h2>Payment schedule</h2></div></div><div class="pay">${pays.map((p) => `<div><b>${esc(p.label)}</b><div class="sub">${esc(p.when || "")}${p.note ? " · " + esc(p.note) : ""}</div></div><div class="amt">${money(p.amount)}</div>`).join("")}<div class="total">Total</div><div class="amt total">${money(payTotal)}</div></div></section>` : ""}`;
    }
    if (tab === "projects") {
      body = h`${sampleBanner}<div class="page-head"><div><span class="eyebrow">${esc(c.client.name)}</span><h1>Projects</h1><p class="lead">Every film with Mood, from first brief to delivery.</p></div><div class="page-head__actions">${backLink}${c.show.brief ? `<a class="btn btn--ink" href="#/c/${slug}/brief">Brief a new film</a>` : ""}</div></div>
      ${projects.length ? h`<div class="filters" id="pfilters"><button class="fchip" aria-pressed="true" data-f="all">All <span class="faint">${projects.length}</span></button><button class="fchip" aria-pressed="false" data-f="live">Live <span class="faint">${live.length}</span></button>${STATUSES.filter((s) => projects.some((p) => p.status === s)).map((s) => `<button class="fchip" aria-pressed="false" data-f="${esc(s)}">${esc(s)}</button>`)}</div>
      <div class="grid grid--3 section" id="pcards" style="margin-top:20px"></div>
      <section class="card section"><div class="card__head"><h2>All projects</h2></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Team</th><th>Status</th><th>Expected delivery</th><th class="num">Cost</th><th>Draft</th></tr></thead><tbody id="prows"></tbody></table></div></section>` : `<div class="empty">No projects yet. ${c.show.brief ? `The first brief starts the list: <a href="#/c/${slug}/brief">brief a film</a>.` : ""}</div>`}`;
    }
    if (tab === "library") {
      body = h`<div class="page-head"><div><span class="eyebrow">${esc(c.client.name)}</span><h1>Delivered films</h1><p class="lead">Everything Mood has made with ${esc(c.client.name)}.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="lib">${(c.library || []).map((f) => `<a class="libcard" href="${esc(f.url || "#")}" ${f.url ? 'target="_blank" rel="noopener"' : ""}><span class="play"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span><span class="eyebrow">${esc(f.type || "Film")}${f.year ? " · " + esc(f.year) : ""}</span><h3>${esc(f.name)}</h3><p>${esc(f.summary || "")}</p></a>`)}
      ${delivered.map((p) => `<a class="libcard" href="${esc(p.frame_link || "#")}" ${p.frame_link ? 'target="_blank" rel="noopener"' : ""}><span class="eyebrow">Delivered · ${fmtShort(p.expected_delivery)}</span><h3>${esc(p.name)}</h3><p>${esc(p.summary || "")}</p></a>`)}</div>
      ${!(c.library || []).length && !delivered.length ? `<div class="empty">Delivered films will be collected here.</div>` : ""}`;
    }
    if (tab === "brief") {
      const b = c.briefing || {};
      body = h`<div class="page-head"><div><span class="eyebrow">${esc(c.client.name)}</span><h1>Brief a film</h1><p class="lead">A brief is a description of a problem, not a specification for a film. Tell us what should be different after people watch it, and who has to act. We'll propose the right film.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="grid grid--main"><section class="card card--ink"><div class="card__head"><h2>Three steps</h2></div>
          <div class="steps"><div class="step" style="color:rgba(255,255,255,.75)"><div><b style="color:#fff">${b.form_url ? "Download the briefing form" : "Write a short brief"}</b>${b.form_url ? "Twelve short questions, about fifteen minutes. “Don't know yet” is a fine answer." : "A few lines on the goal, the audience and the deadline is enough to start."}</div></div><div class="step" style="color:rgba(255,255,255,.75)"><div><b style="color:#fff">Send it to Mood</b>${b.form_url ? "Via your marketing contact, or straight to us if it's already approved." : "Email it to your producer."}</div></div><div class="step" style="color:rgba(255,255,255,.75)"><div><b style="color:#fff">Options, quote and timeline</b>${esc(b.turnaround || "Back to you within two working days.")}</div></div></div>
          <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">${b.form_url ? `<a class="btn btn--lime" href="${esc(b.form_url)}" target="_blank" rel="noopener">Download the briefing form</a>` : ""}<a class="btn ${b.form_url ? "btn--ghost on-dark" : "btn--lime"}" href="mailto:${esc(b.send_to || "hello@moodfilms.co.uk")}?subject=${encodeURIComponent("New film brief — " + c.client.name)}">Email a brief</a></div></section>
        <section class="card"><div class="card__head"><h2>The two questions that decide everything</h2></div><div class="steps"><div class="step"><div><b>What should be different after people watch it?</b>More applicants for a hard-to-fill role, a team that understands a new process, a client who renews. One sentence.</div></div><div class="step"><div><b>Who has to act, and what do they think today?</b>Name the audience precisely. “Everyone” is not a brief.</div></div></div>
          <p class="muted" style="margin-top:18px;font-size:13px">Start with the outcome, not the format. Where the film lives decides the length, and a 15-second cut and a two-minute film often come from the same shoot.</p></section></div>
      ${(b.formats || []).length ? `<div class="section"><div class="section__head"><div><span class="eyebrow">What's possible</span><h2>Kinds of film</h2></div></div><div class="formats">${b.formats.map((f) => `<div class="format"><h4>${esc(f.name)}</h4><p>${esc(f.best_for || "")}</p><p>${esc(f.shape || "")}</p></div>`).join("")}</div></div>` : ""}`;
    }
    if (tab === "internal" && team) {
      const int = internal || { projects: {}, risks: [], notes: "" };
      const costTotal = projects.reduce((s, p) => s + (+int.projects?.[p.id]?.cost_to_mood || 0), 0), revenue = m ? m.within + m.overage : projects.reduce((s, p) => s + (+p.client_cost || 0), 0), gp = revenue - costTotal;
      body = h`<div class="page-head"><div><span class="eyebrow" style="color:var(--magenta)">Mood only · never shown to the client</span><h1>Internal view</h1><p class="lead">What this account is costing Mood, project by project, and what still needs invoicing.</p></div><div class="page-head__actions">${backLink}<a class="btn btn--ink btn--sm" href="#/c/${slug}/admin">Edit this hub</a></div></div>
      <div class="grid grid--4">${stat("Revenue to date", money(revenue), m ? "within allowance + overage" : "sum of project costs", "card--ink")}${stat("Cost to Mood", money(costTotal), "estimated or booked costs")}${stat("Gross profit", money(gp), `<span class="delta delta--${revenue && gp / revenue >= 0.4 ? "good" : gp > 0 ? "warn" : "neutral"}">${revenue ? pct(gp / revenue) + " margin" : "No revenue yet"}</span>`)}${stat("Overage to invoice", money(m?.overage || 0), m?.overage ? `<span class="delta delta--warn">Raise on top of the retainer</span>` : "Nothing outside the allowance")}</div>
      <div class="grid grid--main section"><section class="card"><div class="card__head"><h2>Margin by project</h2></div>${projects.length ? `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th class="num">Charged</th><th class="num">Cost to Mood</th><th class="num">Margin</th><th>Note</th></tr></thead>
          <tbody>${projects.map((p) => { const i = int.projects?.[p.id] || {}; const mg = p.client_cost ? (p.client_cost - (+i.cost_to_mood || 0)) / p.client_cost : null; return `<tr><td><b>${esc(p.name)}</b></td><td>${pill(p.status)}</td><td class="num">${money(p.client_cost)}</td><td class="num">${i.cost_to_mood != null && i.cost_to_mood !== "" ? money(i.cost_to_mood) : "—"}</td><td class="num">${mg == null ? "—" : `<span class="delta delta--${mg >= 0.4 ? "good" : mg > 0.2 ? "warn" : "bad"}">${pct(mg)}</span>`}</td><td><div class="sub">${esc(i.note || "")}</div></td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty">No projects yet. Add them in <a href="#/c/${slug}/admin">Edit this hub</a>.</div>`}</section>
        <div style="display:grid;gap:16px"><section class="card"><div class="card__head"><h3>Account notes</h3></div><p class="internal-note">${esc(int.notes || "No notes yet.")}</p></section>
          <section class="card"><div class="card__head"><h3>Watch-outs</h3></div>${(int.risks || []).length ? int.risks.map((r) => `<div class="risk">${esc(r)}</div>`).join("") : '<p class="faint">None logged.</p>'}</section>
          ${m ? `<section class="card"><div class="card__head"><h3>Billing</h3></div><dl class="kv"><dt>Invoiced (Xero)</dt><dd>${money(m.invoiced)}</dd><dt>Paid</dt><dd>${money(m.paid)}</dd><dt>Expired carry-over</dt><dd>${money(m.expired)}</dd></dl></section>` : ""}</div></div>`;
    }
    if (tab === "admin" && team) { renderEditor(slug); return; }
    shell(body, { client: c, tabs, active: tab });
    if (tab === "money") wireChart(m);
    if (tab === "projects" && projects.length) {
      const draw = (f) => { const list = projects.filter((p) => f === "all" || (f === "live" ? !DONE.has(p.status) : p.status === f)).sort((a, b) => (b.pinned - a.pinned) || (a.expected_delivery || "9999").localeCompare(b.expected_delivery || "9999"));
        document.getElementById("pcards").innerHTML = list.length ? list.map(projectCard).join("") : `<div class="empty" style="grid-column:1/-1">Nothing here.</div>`;
        document.getElementById("prows").innerHTML = list.map((p) => `<tr><td><b><a class="plain" href="#/c/${slug}/p/${esc(p.id)}">${esc(p.name)}</a></b>${p.summary ? `<div class="sub">${esc(p.summary)}</div>` : ""}</td><td>${esc(p.department || "—")}</td><td>${pill(p.status)}</td><td>${fmtDate(p.expected_delivery)}</td><td class="num">${p.client_cost ? money(p.client_cost) : "TBC"}</td><td>${p.frame_link ? `<a class="tbl-link" href="${esc(p.frame_link)}" target="_blank" rel="noopener">Open ↗</a>` : "—"}</td></tr>`).join(""); };
      draw("all"); document.querySelectorAll("#pfilters .fchip").forEach((b) => (b.onclick = () => { document.querySelectorAll("#pfilters .fchip").forEach((x) => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); draw(b.dataset.f); }));
    }
    window.scrollTo({ top: 0 });
  }


  /* ---------------- project rundown ---------------- */
  function renderProject(slug, pid, team) {
    const c = session.clients[slug], p = (c.projects || []).find((x) => x.id === pid);
    if (!p) { location.hash = `#/c/${slug}/projects`; return; }
    const int = isTeam() && !session.preview ? session.internal[slug]?.projects?.[pid] : null;
    const si = stageIndex(p.status), onHold = p.status === "On hold", done = DONE.has(p.status);
    const dl = daysUntil(p.expected_delivery);
    const dates = [["Brief received", p.brief_date], ["Shoot", p.shoot_date], ["First cut", p.draft_date], ["Delivery", p.expected_delivery]].filter(([, d]) => d);
    const links = parseLines(p.links), actions = parseLines(p.client_actions), log = parseLines(p.log, "|").map(([d, t]) => (t ? { date: d, text: t } : { date: "", text: d })).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const lead = c.client.mood_lead || {};
    const body = h`<div class="page-head"><div><a class="crumb" href="#/c/${slug}/projects">← ${esc(c.client.name)} · all projects</a><div style="display:flex;gap:10px;align-items:center;margin-top:10px">${pill(p.status)}${p.department ? `<span class="faint" style="font-size:13px;font-weight:600">${esc(p.department)}</span>` : ""}</div><h1 style="margin-top:10px">${esc(p.name)}</h1>${p.summary ? `<p class="lead">${esc(p.summary)}</p>` : ""}</div>
      <div class="page-head__actions">${team ? `<a class="btn btn--ghost btn--sm" href="#/c/${slug}/admin">Edit</a>` : ""}${p.frame_link ? `<a class="btn btn--ink" href="${esc(p.frame_link)}" target="_blank" rel="noopener">Latest draft ${extIcon}</a>` : ""}</div></div>
      <div class="grid grid--4">
        ${stat("Delivery", p.expected_delivery ? fmtShort(p.expected_delivery) : "TBC", done ? `<span class="delta delta--good">Delivered</span>` : dl == null ? "date to confirm" : dl < 0 ? `<span class="delta delta--bad">${-dl} days overdue</span>` : dl === 0 ? `<span class="delta delta--warn">Today</span>` : `in ${dl} day${dl === 1 ? "" : "s"}`, "card--ink")}
        ${stat("Stage", onHold ? "On hold" : si >= 0 ? STAGES[si].k : p.status, onHold ? "paused for now" : si >= 0 && si < STAGES.length - 1 ? `next: ${STAGES[si + 1].k}` : "complete")}
        ${stat(c.retainer ? "Cost to retainer" : "Cost", p.client_cost ? money(p.client_cost) : "TBC", c.retainer && p.charge_date ? `charged to ${mlabel(p.charge_date.slice(0, 7))}` : c.retainer && p.expected_delivery ? `charged to ${mlabel(p.expected_delivery.slice(0, 7))}` : "")}
        ${int ? stat("Margin", p.client_cost && int.cost_to_mood != null && int.cost_to_mood !== "" ? pct((p.client_cost - int.cost_to_mood) / p.client_cost) : "—", `<span class="chip" style="background:var(--magenta);color:#fff">Mood only</span> ${int.cost_to_mood != null && int.cost_to_mood !== "" ? money(int.cost_to_mood) + " cost" : "no cost logged"}`) : stat("Deliverables", (p.deliverables || []).length || "—", (p.deliverables || []).length ? "in this project" : "to be agreed")}</div>
      <section class="card section"><div class="card__head"><div><span class="eyebrow">Where it is</span><h2>Production stages</h2></div>${p.next_step ? `<span class="muted" style="font-size:13px">Next: <b>${esc(p.next_step)}</b></span>` : ""}</div>
        <ol class="stages ${onHold ? "hold" : ""}">${STAGES.map((st, i) => `<li class="${i < si ? "done" : i === si ? "now" : ""}"><i></i><span>${st.k}</span></li>`).join("")}</ol></section>
      <div class="grid grid--main section">
        <div style="display:grid;gap:16px">
          ${(p.deliverables || []).length ? `<section class="card"><div class="card__head"><h2>Deliverables</h2></div><ul class="checklist">${p.deliverables.map((d) => `<li class="${done ? "done" : ""}"><i></i>${esc(d)}</li>`).join("")}</ul></section>` : ""}
          <section class="card"><div class="card__head"><h2>Progress</h2></div>${log.length ? `<div class="feed">${log.map((u) => `<div class="feed__item"><time>${u.date ? fmtShort(u.date) : ""}</time><p>${esc(u.text)}</p></div>`).join("")}</div>` : `<p class="faint">Updates on this project will appear here.</p>`}</section>
          ${links.length ? `<section class="card"><div class="card__head"><h2>Links</h2></div><div class="linklist">${links.map(([l, u]) => `<a href="${esc(u || l)}" target="_blank" rel="noopener">${esc(l)} ${extIcon}</a>`).join("")}</div></section>` : ""}</div>
        <div style="display:grid;gap:16px">
          <section class="card ${actions.length ? "card--accent" : ""}"><div class="card__head"><h2>What we need from you</h2></div>${actions.length ? `<ul class="checklist">${actions.map(([t, d]) => `<li><i></i><div>${esc(t)}${d ? `<span class="sub">${esc(d)}</span>` : ""}</div></li>`).join("")}</ul>` : `<p class="faint">Nothing right now.</p>`}</section>
          ${dates.length ? `<section class="card"><div class="card__head"><h2>Key dates</h2></div><dl class="kv">${dates.map(([l, d]) => `<dt>${l}</dt><dd>${fmtDate(d)}</dd>`).join("")}</dl></section>` : ""}
          <section class="card"><div class="card__head"><h3>Your producer</h3></div><dl class="kv"><dt>Name</dt><dd>${esc(lead.name || "Mood Studio")}</dd><dt>Email</dt><dd><a href="mailto:${esc(lead.email || "hello@moodfilms.co.uk")}?subject=${encodeURIComponent(p.name)}">${esc(lead.email || "hello@moodfilms.co.uk")}</a></dd></dl></section>
          ${int?.note ? `<section class="card" style="border-color:color-mix(in srgb, var(--magenta) 40%, transparent)"><div class="card__head"><h3>Internal note</h3></div><p class="internal-note">${esc(int.note)}</p></section>` : ""}</div></div>`;
    shell(body, { client: c, tabs: portalTabs(slug, c, team), active: "projects" });
    window.scrollTo({ top: 0 });
  }

  /* ---------------- all projects (team) ---------------- */
  function renderTracker(filter = "live") {
    const all = [];
    for (const [slug, c] of Object.entries(session.clients)) for (const p of c.projects || []) all.push({ ...p, slug, client: c.client.name, accent: c.client.accent, int: session.internal[slug]?.projects?.[p.id] || {} });
    const live = all.filter((p) => !DONE.has(p.status)), inProd = live.filter((p) => ["Pre-production", "In production", "In post", "In grade"].includes(p.status));
    const month = isoToday.slice(0, 7), dueMonth = live.filter((p) => (p.expected_delivery || "").startsWith(month)), overdue = live.filter((p) => p.expected_delivery && p.expected_delivery < isoToday);
    const rev = live.reduce((s, p) => s + (+p.client_cost || 0), 0), cost = live.reduce((s, p) => s + (+p.int.cost_to_mood || 0), 0);
    const list = (filter === "all" ? all : filter === "live" ? live : filter === "overdue" ? overdue : filter === "month" ? dueMonth : all.filter((p) => p.status === filter)).sort((a, b) => (a.expected_delivery || "9999").localeCompare(b.expected_delivery || "9999"));
    const chip = (f, label, n) => `<button class="fchip" aria-pressed="${filter === f}" data-f="${f}">${label} <span class="faint">${n}</span></button>`;
    const body = h`<div class="page-head"><div><span class="eyebrow">Mood Studio · internal</span><h1>All projects</h1><p class="lead">Every job across every client, in delivery order. Click a project for its rundown; each client sees only their own.</p></div>
      <div class="page-head__actions"><a class="btn btn--ghost" href="#/">Clients</a><a class="btn btn--ink" href="#/admin/new">+ Add a client</a></div></div>
      <div class="grid grid--4" style="margin-bottom:24px">${stat("Live projects", live.length, `${inProd.length} in production or post`, "card--ink")}${stat("Due this month", dueMonth.length, overdue.length ? `<span class="delta delta--bad">${overdue.length} overdue</span>` : `<span class="delta delta--good">nothing overdue</span>`)}${stat("Live revenue", money(rev), "cost to clients of live work")}${stat("Live margin", rev ? pct((rev - cost) / rev) : "—", `${money(cost)} cost to Mood logged`)}</div>
      <div class="filters">${chip("live", "Live", live.length)}${chip("month", "Due this month", dueMonth.length)}${chip("overdue", "Overdue", overdue.length)}${STATUSES.filter((st) => all.some((p) => p.status === st)).map((st) => chip(st, st, all.filter((p) => p.status === st).length)).join("")}${chip("all", "Everything", all.length)}</div>
      <section class="card section" style="margin-top:20px">${list.length ? `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Client</th><th>Stage</th><th>Delivery</th><th>Next step</th><th class="num">Cost</th><th class="num">Mood cost</th><th class="num">Margin</th></tr></thead><tbody>
        ${list.map((p) => { const d = daysUntil(p.expected_delivery), mg = p.client_cost && p.int.cost_to_mood != null && p.int.cost_to_mood !== "" ? (p.client_cost - p.int.cost_to_mood) / p.client_cost : null; return `<tr><td><b><a class="plain" href="#/c/${p.slug}/p/${esc(p.id)}">${esc(p.name)}</a></b>${p.department ? `<div class="sub">${esc(p.department)}</div>` : ""}</td><td><span class="clientdot" style="--accent:${esc(p.accent || "#2175D9")}"><i class="dot"></i>${esc(p.client)}</span></td><td>${pill(p.status)}</td><td>${p.expected_delivery ? `<b>${fmtShort(p.expected_delivery)}</b><div class="sub">${DONE.has(p.status) ? "delivered" : d < 0 ? `<span style="color:var(--bad)">${-d}d overdue</span>` : d === 0 ? "today" : `in ${d}d`}</div>` : "TBC"}</td><td><div class="sub" style="max-width:28ch">${esc(p.next_step || "")}</div></td><td class="num">${p.client_cost ? money(p.client_cost) : "—"}</td><td class="num">${p.int.cost_to_mood != null && p.int.cost_to_mood !== "" ? money(p.int.cost_to_mood) : "—"}</td><td class="num">${mg == null ? "—" : `<span class="delta delta--${mg >= 0.4 ? "good" : mg > 0.2 ? "warn" : "bad"}">${pct(mg)}</span>`}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty">Nothing here. Add projects from a client's <b>Edit this hub</b>.</div>`}</section>
      <div class="section"><div class="section__head"><div><span class="eyebrow">Quick add</span><h2>Add a project to…</h2></div></div><div class="filters">${Object.entries(session.clients).sort().map(([slug, c]) => `<a class="fchip" href="#/c/${slug}/admin?add=project" style="text-decoration:none">${esc(c.client.name)} +</a>`).join("")}</div></div>`;
    shell(body, { tabs: teamTabs("projects"), active: "projects" });
    document.querySelectorAll(".fchip[data-f]").forEach((b) => (b.onclick = () => renderTracker(b.dataset.f)));
    window.scrollTo({ top: 0 });
  }
  const teamTabs = (active) => [{ id: "clients", label: "Clients", href: "#/" }, { id: "projects", label: "All projects", href: "#/projects" }, { id: "admin", label: "Logins & settings", href: "#/admin", cls: "tab--admin" }];

  /* ---------------- editor (team) ---------------- */
  const drafts = {};
  const deep = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  function setDeep(o, path, v) { const ks = path.split("."); let x = o; ks.slice(0, -1).forEach((k, i) => { x = x[k] ??= (/^\d+$/.test(ks[i + 1]) ? [] : {}); }); x[ks.at(-1)] = v; }
  const inp = (label, path, value, { type = "text", hint = "", wide = false, options = null, placeholder = "" } = {}) => `<div class="f ${wide ? "wide" : ""}"><label>${label}</label>${options ? `<select data-path="${path}">${options.map((o) => `<option value="${esc(o)}" ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>` : type === "textarea" ? `<textarea data-path="${path}" placeholder="${esc(placeholder)}">${esc(value ?? "")}</textarea>` : `<input type="${type}" data-path="${path}" data-type="${type}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}">`}${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  const chk = (label, path, value) => `<div class="f check"><input type="checkbox" data-path="${path}" data-type="checkbox" ${value ? "checked" : ""}><label>${label}</label></div>`;
  function collect(root, draft) {
    root.querySelectorAll("[data-path]").forEach((el) => {
      const t = el.dataset.type || el.tagName.toLowerCase(); let v = el.value;
      if (t === "checkbox") v = el.checked; else if (t === "number") v = v === "" ? null : Number(v); else if (t === "list") v = v.split(",").map((s) => s.trim()).filter(Boolean); else if (t === "lines") v = v.split("\n").map((s) => s.trim()).filter(Boolean);
      setDeep(draft, el.dataset.path, v);
    });
  }
  function renderEditor(slug) {
    const c = session.clients[slug];
    const wantAdd = location.hash.includes("?add=project");
    const d = (drafts[slug] ||= { data: structuredClone(c), internal: structuredClone(session.internal[slug] || { projects: {}, notes: "", risks: [] }) });
    const data = d.data, int = d.internal; if (wantAdd) { (data.projects ||= []).push({ id: "p-" + randomId().slice(0, 8), name: "", status: "Briefing", pinned: false, deliverables: [] }); history.replaceState(null, "", location.hash.replace("?add=project", "")); } data.show ||= { money: !!data.retainer, projects: true, library: true, brief: true, updates: true, team: true };
    const tabs = portalTabs(slug, c, true);
    const projBlock = (p, i) => `<div class="block" data-block="projects" data-i="${i}"><div class="block__head"><b>${esc(p.name || "New project")}</b><button type="button" class="block__del" data-del="projects" data-i="${i}">Remove</button></div><div class="fgrid">
      ${inp("Project name", `projects.${i}.name`, p.name, { wide: true })}${inp("Department / team", `projects.${i}.department`, p.department)}${inp("Status", `projects.${i}.status`, p.status || "Briefing", { options: STATUSES })}
      ${inp("Expected delivery", `projects.${i}.expected_delivery`, p.expected_delivery, { type: "date" })}${inp("Charge to month of", `projects.${i}.charge_date`, p.charge_date, { type: "date", hint: "Leave blank to use the delivery date" })}
      ${inp("Cost to client (£)", `projects.${i}.client_cost`, p.client_cost, { type: "number" })}${inp("Frame / draft link", `projects.${i}.frame_link`, p.frame_link, { placeholder: "https://" })}
      ${inp("Summary", `projects.${i}.summary`, p.summary, { type: "textarea", wide: true })}${inp("Deliverables", `projects.${i}.deliverables`, (p.deliverables || []).join(", "), { hint: "Comma separated" })}${inp("Next step", `projects.${i}.next_step`, p.next_step)}
      ${inp("Brief received", `projects.${i}.brief_date`, p.brief_date, { type: "date" })}${inp("Shoot date", `projects.${i}.shoot_date`, p.shoot_date, { type: "date" })}${inp("First cut", `projects.${i}.draft_date`, p.draft_date, { type: "date" })}
      <div class="f wide"><label>What we need from the client (one per line)</label><textarea data-path="projects.${i}.client_actions" placeholder="Sign off the treatment | by 5 Dec">${esc(p.client_actions || "")}</textarea><span class="hint">Add “| by when” after a line to show a date</span></div>
      <div class="f wide"><label>Progress log (one per line)</label><textarea data-path="projects.${i}.log" placeholder="${isoToday} | Shoot day confirmed at the Leeds office">${esc(p.log || "")}</textarea><span class="hint">Start each line with the date, then |</span></div>
      <div class="f wide"><label>Links (one per line)</label><textarea data-path="projects.${i}.links" placeholder="Treatment | https://… ">${esc(p.links || "")}</textarea></div>
      ${chk("Pin to the top of the overview", `projects.${i}.pinned`, p.pinned)}
      <div class="wide" style="border-top:1px dashed var(--line);padding-top:12px;margin-top:4px"><span class="eyebrow" style="color:var(--magenta)">Internal only</span></div>
      ${inp("Cost to Mood (£)", `__int.projects.${p.id}.cost_to_mood`, int.projects?.[p.id]?.cost_to_mood, { type: "number" })}${inp("Internal note", `__int.projects.${p.id}.note`, int.projects?.[p.id]?.note)}</div></div>`;
    const body = h`<div class="page-head"><div><span class="eyebrow" style="color:var(--magenta)">Admin · ${esc(data.client.name)}</span><h1>Edit this hub</h1><p class="lead">Change anything the client sees. Publish writes it to the live site in about a minute; the client never has to do anything.</p></div><div class="page-head__actions"><a class="btn btn--ghost btn--sm" href="#/">← All clients</a><a class="btn btn--ghost btn--sm" href="#/admin">Logins</a></div></div>
      ${gh.token() ? "" : `<div class="notice warn" style="margin-bottom:20px">Publishing from the browser needs a GitHub token. <a href="#/admin/settings">Add one in Settings</a>, or use “Download JSON” and publish from the Mac.</div>`}
      <form class="ed" id="editor" onsubmit="return false">
      <section class="card"><div class="card__head"><h2>Client</h2></div><div class="fgrid">${inp("Client name", "client.name", data.client.name)}${inp("Hub subtitle", "client.tagline", data.client.tagline)}${inp("Accent colour", "client.accent", data.client.accent, { type: "color" })}
        ${inp("Mood lead", "client.mood_lead.name", data.client.mood_lead?.name)}${inp("Mood lead email", "client.mood_lead.email", data.client.mood_lead?.email)}${inp("Team on the account", "client.mood_team", (data.client.mood_team || []).join(", "), { hint: "Comma separated" })}
        ${chk("Mark as sample figures (shows a warning banner)", "sample", data.sample)}</div></section>
      <section class="card"><div class="card__head"><h2>What they can see</h2></div><div class="toggles">${chk("Retainer & money", "show.money", data.show.money)}${chk("Projects", "show.projects", data.show.projects)}${chk("Delivered films", "show.library", data.show.library)}${chk("Brief a film", "show.brief", data.show.brief)}${chk("Latest from Mood", "show.updates", data.show.updates)}${chk("Your team at Mood", "show.team", data.show.team)}</div></section>
      <section class="card"><div class="card__head"><h2>Retainer</h2>${data.retainer ? `<button type="button" class="block__del" id="rm-retainer">Remove retainer (project-only client)</button>` : `<button type="button" class="btn btn--ghost btn--sm" id="add-retainer">+ Add a retainer</button>`}</div>
        ${data.retainer ? `<div class="fgrid">${inp("Retainer name", "retainer.name", data.retainer.name, { wide: true })}${inp("Start date", "retainer.start_date", data.retainer.start_date, { type: "date" })}${inp("Months", "retainer.initial_months", data.retainer.initial_months, { type: "number" })}${inp("Monthly value (£)", "retainer.monthly_value", data.retainer.monthly_value, { type: "number" })}${inp("Carry-over months", "retainer.carry_over_months", data.retainer.carry_over_months ?? 1, { type: "number", hint: "How long unused allowance lasts" })}
          ${inp("Extension months", "retainer.extension_months", data.retainer.extension_months || 0, { type: "number", hint: "0 for none" })}${inp("Extension status", "retainer.extension_status", data.retainer.extension_status || "none", { options: ["none", "option", "taken", "declined"] })}${inp("Terms shown to the client", "retainer.terms", data.retainer.terms, { type: "textarea", wide: true })}</div>
          <div style="margin-top:18px"><div class="section__head"><h3>Payment schedule</h3><button type="button" class="btn btn--ghost btn--sm" data-add="payments">+ Add payment</button></div>
          ${(data.payments || []).map((p, i) => `<div class="block"><div class="block__head"><b>${esc(p.label || "Payment")}</b><button type="button" class="block__del" data-del="payments" data-i="${i}">Remove</button></div><div class="fgrid">${inp("Label", `payments.${i}.label`, p.label)}${inp("Amount (£)", `payments.${i}.amount`, p.amount, { type: "number" })}${inp("When", `payments.${i}.when`, p.when)}${inp("Note", `payments.${i}.note`, p.note)}</div></div>`).join("")}</div>` : `<p class="muted">No retainer: this hub shows projects, films and briefing only.</p>`}</section>
      <section class="card"><div class="card__head"><h2>Projects <span class="faint" style="font-weight:600;font-size:14px">${(data.projects || []).length}</span></h2><button type="button" class="btn btn--ink btn--sm" data-add="projects">+ Add project</button></div>
        ${(data.projects || []).length ? data.projects.map(projBlock).join("") : `<div class="empty">No projects yet. Add the first one.</div>`}</section>
      <section class="card"><div class="card__head"><h2>Latest from Mood</h2><button type="button" class="btn btn--ghost btn--sm" data-add="updates">+ Add update</button></div>
        ${(data.updates || []).map((u, i) => `<div class="block"><div class="block__head"><b>${esc(u.date || "Update")}</b><button type="button" class="block__del" data-del="updates" data-i="${i}">Remove</button></div><div class="fgrid">${inp("Date", `updates.${i}.date`, u.date, { type: "date" })}${inp("Update", `updates.${i}.text`, u.text, { type: "textarea", wide: true })}</div></div>`).join("") || `<p class="muted">Nothing posted yet.</p>`}</section>
      <section class="card"><div class="card__head"><h2>Delivered films</h2><button type="button" class="btn btn--ghost btn--sm" data-add="library">+ Add film</button></div>
        ${(data.library || []).map((f, i) => `<div class="block"><div class="block__head"><b>${esc(f.name || "Film")}</b><button type="button" class="block__del" data-del="library" data-i="${i}">Remove</button></div><div class="fgrid">${inp("Title", `library.${i}.name`, f.name, { wide: true })}${inp("Type", `library.${i}.type`, f.type)}${inp("Year", `library.${i}.year`, f.year)}${inp("Link", `library.${i}.url`, f.url, { placeholder: "https://" })}${inp("One line", `library.${i}.summary`, f.summary, { wide: true })}</div></div>`).join("") || `<p class="muted">Nothing in the library yet.</p>`}</section>
      <section class="card"><div class="card__head"><h2>Briefing</h2></div><div class="fgrid">${inp("Briefing form link", "briefing.form_url", data.briefing?.form_url, { placeholder: "assets/… or https://", wide: true })}${inp("Send briefs to", "briefing.send_to", data.briefing?.send_to)}${inp("Turnaround", "briefing.turnaround", data.briefing?.turnaround)}</div></section>
      <section class="card" style="border-color:color-mix(in srgb, var(--magenta) 40%, transparent)"><div class="card__head"><h2>Internal notes <span class="chip" style="background:var(--magenta);color:#fff">Mood only</span></h2></div><div class="fgrid">${inp("Account notes", "__int.notes", int.notes, { type: "textarea", wide: true })}<div class="f wide"><label>Watch-outs (one per line)</label><textarea data-path="__int.risks" data-type="lines">${esc((int.risks || []).join("\n"))}</textarea></div></div></section>
      <div class="savebar"><button type="button" class="btn btn--lime" id="publish">Publish to the live site</button><button type="button" class="btn btn--ghost on-dark" id="download">Download JSON</button><button type="button" class="btn btn--ghost on-dark btn--sm" id="discard">Discard changes</button><span class="msg" id="msg">Changes are kept in this tab until you publish.</span></div></form>`;
    shell(body, { client: c, tabs, active: "admin" });
    const form = document.getElementById("editor");
    const syncDraft = () => { const tmp = { __int: {} }; collect(form, tmp); const { __int, ...rest } = tmp;
      // merge collected values onto the draft (arrays rebuilt from the form)
      for (const k of Object.keys(rest)) { if (k === "client") { data.client = { ...data.client, ...rest.client, mood_lead: { ...data.client.mood_lead, ...rest.client.mood_lead }, mood_team: String(rest.client.mood_team ?? "").split(",").map((s) => s.trim()).filter(Boolean) }; } else if (["projects", "payments", "updates", "library"].includes(k)) { data[k] = (rest[k] || []).filter(Boolean).map((x, i) => ({ ...(data[k]?.[i] || {}), ...x, ...(k === "projects" ? { deliverables: String(x.deliverables ?? "").split(",").map((s) => s.trim()).filter(Boolean), id: data[k]?.[i]?.id || "p-" + randomId().slice(0, 8) } : {}) })); } else if (k === "retainer") { data.retainer = { ...data.retainer, ...rest.retainer }; } else data[k] = typeof rest[k] === "object" && !Array.isArray(rest[k]) ? { ...data[k], ...rest[k] } : rest[k]; }
      if (__int.notes != null) int.notes = __int.notes; if (__int.risks) int.risks = __int.risks; if (__int.projects) for (const [id, v] of Object.entries(__int.projects)) int.projects[id] = { ...(int.projects[id] || {}), ...v };
      return { data, int }; };
    form.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => { syncDraft(); const k = b.dataset.add; (data[k] ||= []).push(k === "projects" ? { id: "p-" + randomId().slice(0, 8), name: "", status: "Briefing", pinned: false, deliverables: [] } : k === "updates" ? { date: isoToday, text: "" } : {}); renderEditor(slug); }));
    form.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { syncDraft(); data[b.dataset.del].splice(+b.dataset.i, 1); renderEditor(slug); }));
    document.getElementById("add-retainer")?.addEventListener("click", () => { syncDraft(); data.retainer = { name: `${data.client.name} × Mood retainer`, start_date: isoToday.slice(0, 8) + "01", initial_months: 3, extension_months: 0, extension_status: "none", monthly_value: 0, carry_over_months: 1, terms: "" }; data.show.money = true; renderEditor(slug); });
    document.getElementById("rm-retainer")?.addEventListener("click", async () => { if (await confirmModal("Remove the retainer?", "The hub becomes project-only. Projects and films stay.", "Remove")) { syncDraft(); data.retainer = null; data.payments = []; data.show.money = false; renderEditor(slug); } });
    document.getElementById("discard").onclick = () => { delete drafts[slug]; renderEditor(slug); };
    document.getElementById("download").onclick = () => { syncDraft(); const dl = (name, obj) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" })); a.download = name; a.click(); }; const { kind, ...plain } = data; dl(`${slug}.json`, plain); dl(`${slug}.internal.json`, int); };
    document.getElementById("publish").onclick = async () => { const msg = document.getElementById("msg"), btn = document.getElementById("publish"); syncDraft();
      if (!gh.token()) { msg.className = "msg err"; msg.innerHTML = `No GitHub token yet: <a href="#/admin/settings" style="color:#fff">add one in Settings</a>, or download the JSON and run npm run publish on the Mac.`; return; }
      btn.disabled = true; msg.className = "msg"; msg.textContent = "Encrypting and publishing…";
      try { const { kind, ...plain } = data; await publishBundle(slug, "client", plain); const { kind: k2, ...pi } = int; await publishBundle(slug, "internal", pi); drafts[slug] = { data: structuredClone(session.clients[slug]), internal: structuredClone(session.internal[slug]) }; msg.className = "msg ok"; msg.textContent = "Published. The live site updates in about a minute; the hub here already shows the new version."; }
      catch (e) { msg.className = "msg err"; msg.textContent = e.message; } btn.disabled = false; };
  }

  /* ---------------- clients & logins (team) ---------------- */
  function renderAdmin(sub) {
    const slugs = Object.keys(session.clients).sort();
    let body = "";
    if (sub === "new") {
      body = h`<div class="page-head"><div><span class="eyebrow" style="color:var(--magenta)">Admin</span><h1>Add a client</h1><p class="lead">Creates their hub and their login. Everything is encrypted in this browser before it reaches GitHub.</p></div><div class="page-head__actions"><a class="btn btn--ghost btn--sm" href="#/admin">← Clients &amp; logins</a></div></div>
      ${gh.token() ? "" : `<div class="notice warn" style="margin-bottom:20px">Adding a client from the browser needs a GitHub token. <a href="#/admin/settings">Add one in Settings</a>, or add the client in config/clients.json on the Mac and run npm run publish.</div>`}
      <form class="ed" id="newc" style="max-width:820px"><section class="card"><div class="card__head"><h2>Who</h2></div><div class="fgrid">${inp("Client name", "name", "", { placeholder: "e.g. Superdrug" })}${inp("Accent colour", "accent", "#2175D9", { type: "color" })}${inp("Username", "username", "", { hint: "What they type to sign in; lower-case" })}${inp("Passcode", "password", "", { hint: "Pattern so far: ClientxMood26" })}</div></section>
        <section class="card"><div class="card__head"><h2>First project</h2></div><div class="fgrid">${inp("Project name", "p_name", "", { wide: true, placeholder: "e.g. Spring recruitment film" })}${inp("Expected delivery", "p_delivery", "", { type: "date" })}${inp("Cost to client (£)", "p_cost", "", { type: "number" })}${inp("Status", "p_status", "Briefing", { options: STATUSES })}</div><p class="ed__help" style="margin-top:10px">Optional. Everything else about the project is filled in afterwards in “Edit this hub”.</p></section>
        <section class="card"><div class="card__head"><h2>Retainer</h2></div><div class="fgrid">${chk("This client is on a retainer (monthly allowance)", "has_retainer", false)}${inp("Start date", "start_date", isoToday.slice(0, 8) + "01", { type: "date" })}${inp("Months", "initial_months", 3, { type: "number" })}${inp("Monthly value (£)", "monthly_value", 0, { type: "number" })}${inp("Extension months (0 for none)", "extension_months", 0, { type: "number" })}</div><p class="ed__help" style="margin-top:10px">Leave unticked for project-by-project clients; their hub shows projects, films and briefing without the money tab.</p></section>
        <div class="savebar"><button class="btn btn--lime" id="create">Create client &amp; login</button><span class="msg" id="msg"></span></div></form>`;
    } else if (sub === "settings") {
      body = h`<div class="page-head"><div><span class="eyebrow" style="color:var(--magenta)">Admin</span><h1>Publishing settings</h1><p class="lead">The hub publishes straight to its GitHub repository from your browser. It needs a token that can write to that one repository.</p></div><div class="page-head__actions"><a class="btn btn--ghost btn--sm" href="#/admin">← Clients &amp; logins</a></div></div>
      <div class="grid grid--main"><section class="card"><div class="card__head"><h2>GitHub token</h2></div><div class="fgrid"><div class="f wide"><label>Fine-grained personal access token</label><input type="password" id="tok" value="${esc(gh.token())}" placeholder="github_pat_…"><span class="hint">Stored only in this browser (localStorage). Each team member adds their own.</span></div></div>
        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap"><button class="btn btn--ink btn--sm" id="save-tok">Save</button><button class="btn btn--ghost btn--sm" id="test-tok">Test connection</button><button class="btn btn--ghost btn--sm" id="clear-tok">Forget token</button><span class="muted" id="tok-msg" style="font-size:13px;align-self:center"></span></div></section>
        <section class="card"><div class="card__head"><h3>How to make one</h3></div><div class="steps"><div class="step"><div><b>GitHub → Settings → Developer settings</b>Personal access tokens → Fine-grained tokens → Generate new token.</div></div><div class="step"><div><b>Repository access: only <code class="k">${esc(gh.hub().repo)}</code></b>Permissions → Repository → Contents: <b>Read and write</b>. Nothing else.</div></div><div class="step"><div><b>Expiry</b>Pick a year; you'll paste a new one when it runs out.</div></div></div></section></div>`;
    } else {
      body = h`<div class="page-head"><div><span class="eyebrow" style="color:var(--magenta)">Admin</span><h1>Clients &amp; logins</h1><p class="lead">Every hub, who can open it, and the tools to change that. Passcodes are never stored anywhere readable.</p></div><div class="page-head__actions"><a class="btn btn--ghost btn--sm" href="#/">← Dashboards</a><a class="btn btn--ghost btn--sm" href="#/admin/settings">Settings ${gh.token() ? "✓" : "· no token"}</a><a class="btn btn--ink btn--sm" href="#/admin/new">+ Add a client</a></div></div>
      <div class="rowlist">${slugs.map((slug) => { const c = session.clients[slug]; const users = Object.values(manifest.accounts).filter((a) => a.kind === "client" && a.keys[session.ids[slug]?.client]).length; return `<div class="row-c" style="--accent:${esc(c.client.accent || "#2175D9")}"><div class="who"><i class="dot"></i><div>${esc(c.client.name)}<div class="sub">${esc(slug)} · ${users} login${users === 1 ? "" : "s"} · ${(c.projects || []).length} projects${c.retainer ? " · retainer " + money(c.retainer.monthly_value) + "/mo" : ""}</div></div></div>
        <div class="acts"><a class="btn btn--ghost btn--sm" href="#/c/${slug}">Open</a><a class="btn btn--ghost btn--sm" href="#/c/${slug}/admin">Edit hub</a><button class="btn btn--ghost btn--sm" data-login="${slug}">Set username &amp; passcode</button><button class="btn btn--sm btn--danger" data-remove="${slug}">Remove</button></div></div>`; }).join("")}
      ${!slugs.length ? `<div class="empty">No clients yet.</div>` : ""}</div>
      <p class="muted" style="margin-top:20px;font-size:13px">The team login itself is set in <code class="k">config/clients.json</code> on the Mac (run <code class="k">npm run publish</code> after changing it).</p>`;
    }
    shell(body, { tabs: teamTabs("admin"), active: "admin" });
    document.getElementById("save-tok")?.addEventListener("click", () => { gh.setToken(document.getElementById("tok").value.trim()); document.getElementById("tok-msg").textContent = "Saved in this browser."; });
    document.getElementById("clear-tok")?.addEventListener("click", () => { gh.setToken(""); document.getElementById("tok").value = ""; document.getElementById("tok-msg").textContent = "Forgotten."; });
    document.getElementById("test-tok")?.addEventListener("click", async () => { const el = document.getElementById("tok-msg"); gh.setToken(document.getElementById("tok").value.trim()); el.textContent = "Testing…"; try { el.textContent = (await gh.test()) === "ok" ? "Connected: this token can publish." : await gh.test(); } catch (e) { el.textContent = e.message; } });
    $root.querySelectorAll("[data-login]").forEach((b) => (b.onclick = async () => { const slug = b.dataset.login; const u = await modalPrompt("Username for " + session.clients[slug].client.name, "What they type to sign in.", "text", slug); if (!u) return; const p = await modalPrompt("New passcode", "Share it with the client; it is not stored anywhere readable.", "text"); if (!p) return; b.disabled = true; b.textContent = "Saving…"; try { await setClientLogin(slug, u.trim().toLowerCase(), p); renderAdmin(); } catch (e) { alert(e.message); renderAdmin(); } }));
    $root.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = async () => { const slug = b.dataset.remove; if (!(await confirmModal("Remove " + session.clients[slug].client.name + "?", "Deletes their hub and login from the live site. This cannot be undone from the browser.", "Remove client"))) return; b.disabled = true; b.textContent = "Removing…"; try { await removeClient(slug); renderAdmin(); } catch (e) { alert(e.message); renderAdmin(); } }));
    const nf = document.getElementById("newc");
    if (nf) nf.onsubmit = async (e) => { e.preventDefault(); const v = {}; collect(nf, v); const msg = document.getElementById("msg"), btn = document.getElementById("create");
      const name = (v.name || "").trim(), username = (v.username || "").trim().toLowerCase(), slug = slugify(name);
      if (!name || !username || !v.password) { msg.className = "msg err"; msg.textContent = "Name, username and passcode are all needed."; return; }
      if (!gh.token()) { msg.className = "msg err"; msg.textContent = "Add a GitHub token in Settings first."; return; }
      btn.disabled = true; msg.className = "msg"; msg.textContent = "Creating keys, encrypting and publishing…";
      try { await createClient({ name, slug, username, password: v.password, accent: v.accent, retainer: v.has_retainer ? { start_date: v.start_date, initial_months: v.initial_months, monthly_value: v.monthly_value, extension_months: v.extension_months } : null, project: v.p_name ? { id: "p-" + randomId().slice(0, 8), name: v.p_name.trim(), status: v.p_status || "Briefing", expected_delivery: v.p_delivery || null, client_cost: +v.p_cost || 0, pinned: true, deliverables: [] } : null }); location.hash = `#/c/${slug}/admin`; }
      catch (err) { msg.className = "msg err"; msg.textContent = err.message; btn.disabled = false; } };
    window.scrollTo({ top: 0 });
  }

  /* ---------------- router ---------------- */
  function route() {
    if (!session.kind) return renderGate();
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (session.kind === "client") { const slug = Object.keys(session.clients)[0]; if (parts[0] !== "c" || parts[1] !== slug) { location.hash = `#/c/${slug}`; return; } return renderClient(slug, ["internal", "admin"].includes(parts[2]) ? "overview" : parts[2] || "overview", parts[3]); }
    if (parts[0] === "c" && parts[1]) { if (session.preview && ["internal", "admin"].includes(parts[2])) parts[2] = "overview"; return renderClient(parts[1], (parts[2] || "overview").split("?")[0], parts[3]); }
    session.preview = false;
    if (parts[0] === "projects") return renderTracker();
    if (parts[0] === "admin") return renderAdmin(parts[1]);
    renderPortfolio();
  }
  window.addEventListener("hashchange", route);
  (async () => {
    try { manifest = await (await fetch("data/manifest.json?t=" + Date.now(), { cache: "no-store" })).json(); }
    catch { $root.innerHTML = `<p style="padding:40px">The hub hasn't been built yet. Run <code>npm run build</code>.</p>`; return; }
    await restoreSession(); route();
  })();
})();
