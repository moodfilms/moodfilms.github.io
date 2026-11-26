/* Mood Client Hub — front end. Everything the browser shows is decrypted here with the
   viewer's password; the host only ever stores ciphertext. */
(() => {
  "use strict";
  const $root = document.getElementById("root");
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
  const money = (v) => gbp.format(Math.round(Number(v) || 0));
  const pct = (v) => Math.round((Number(v) || 0) * 100) + "%";
  const fmtDate = (iso, opts = { day: "numeric", month: "short", year: "numeric" }) => iso ? new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-GB", opts) : "—";
  const fmtShort = (iso) => fmtDate(iso, { day: "numeric", month: "short" });
  const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  
  const STATUSES = ["Briefing", "Approved", "In creative", "In production", "In post", "In grade", "Delivered", "On hold"];
  const DONE = new Set(["Delivered"]);

  /* ---------------- crypto ---------------- */
  async function sha(text) {
    const h = await crypto.subtle.digest("SHA-256", enc.encode(text));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
  }
  async function deriveKek(password, saltB64, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations }, base, { name: "AES-GCM", length: 256 }, false, ["unwrapKey"]);
  }
  async function unwrap(kek, w) {
    return crypto.subtle.unwrapKey("raw", b64d(w.wrapped), kek, { name: "AES-GCM", iv: b64d(w.iv) }, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }
  async function openBundle(file, key) {
    const r = await fetch("data/" + file, { cache: "no-store" });
    const { iv, ct } = await r.json();
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, key, b64d(ct));
    return JSON.parse(dec.decode(pt));
  }

  /* ---------------- session ---------------- */
  const session = { kind: null, label: "", clients: {}, internal: {}, keys: null };
  async function saveSession(username, keys) {
    const raw = {};
    for (const [id, k] of Object.entries(keys)) raw[id] = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", k))));
    try { sessionStorage.setItem("mood-hub", JSON.stringify({ username, raw })); } catch {}
  }
  async function restoreSession(manifest) {
    try {
      const s = JSON.parse(sessionStorage.getItem("mood-hub") || "null");
      if (!s) return false;
      const acctId = await sha("acct:" + s.username.toLowerCase());
      const acct = manifest.accounts[acctId];
      if (!acct) return false;
      const keys = {};
      for (const [id, raw] of Object.entries(s.raw)) if (acct.keys[id]) keys[id] = await crypto.subtle.importKey("raw", b64d(raw), { name: "AES-GCM" }, true, ["decrypt"]);
      await loadBundles(manifest, acct, keys, s.username);
      return true;
    } catch { return false; }
  }
  async function loadBundles(manifest, acct, keys, username) {
    session.kind = acct.kind; session.label = acct.kind === "team" ? acct.label : username; session.username = username;
    session.clients = {}; session.internal = {};
    for (const [id, key] of Object.entries(keys)) {
      const b = await openBundle(manifest.bundles[id].file, key);
      if (b.kind === "internal") session.internal[b.slug] = b; else session.clients[b.slug] = b;
    }
    session.builtAt = manifest.built_at;
  }
  async function login(manifest, username, password) {
    const acct = manifest.accounts[await sha("acct:" + username.trim().toLowerCase())];
    if (!acct) throw new Error("We don't recognise that username.");
    const kek = await deriveKek(password, acct.salt, acct.iterations);
    const keys = {};
    for (const [id, w] of Object.entries(acct.keys)) {
      try { keys[id] = await unwrap(kek, w); } catch { throw new Error("That password isn't right."); }
    }
    await loadBundles(manifest, acct, keys, username.trim());
    await saveSession(username.trim(), keys);
  }
  function logout() { try { sessionStorage.removeItem("mood-hub"); } catch {} location.hash = ""; location.reload(); }

  /* ---------------- retainer maths (mirrors finance/retainers.py) ---------------- */
  const addMonths = (d, n) => { const x = new Date(d); const day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n); x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); return x; };
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const dayDiff = (a, b) => Math.round((b - a) / 86400000);
  const parse = (s) => new Date(s + "T00:00:00");
  const mkey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const mlabel = (k) => new Date(k + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }).replace(" ", " ’");

  function timeline(r) {
    const start = parse(r.start_date);
    const initialEnd = new Date(addMonths(start, +r.initial_months)); initialEnd.setDate(initialEnd.getDate() - 1);
    const extStart = new Date(initialEnd); extStart.setDate(extStart.getDate() + 1);
    const extEnd = new Date(addMonths(extStart, +r.extension_months)); extEnd.setDate(extEnd.getDate() - 1);
    const status = r.extension_status || "option";
    const contractEnd = status === "taken" ? extEnd : initialEnd;
    const seg = (a, b) => { const total = dayDiff(a, b) + 1; const done = Math.min(Math.max(dayDiff(a, TODAY) + 1, 0), total); return { start: a, end: b, days: total, days_done: done, days_left: total - done, pct: total ? done / total : 0 }; };
    const phase = TODAY < start ? "before start" : TODAY <= initialEnd ? "initial term" : status === "taken" && TODAY <= extEnd ? "extension" : "ended";
    const decisionBy = new Date(initialEnd); decisionBy.setDate(decisionBy.getDate() - 30);
    return { start, initialEnd, extStart, extEnd, contractEnd, status, phase, initial: seg(start, initialEnd), extension: seg(extStart, extEnd), contract: seg(start, contractEnd), decisionBy: status === "option" ? decisionBy : null, monthsTotal: +r.initial_months + (status === "taken" ? +r.extension_months : 0) };
  }
  function contractMonths(r, includeOption) {
    const start = parse(r.start_date); start.setDate(1);
    let n = +r.initial_months; const st = r.extension_status || "option";
    if (st === "taken" || (includeOption && st === "option")) n += +r.extension_months;
    return Array.from({ length: n }, (_, i) => mkey(addMonths(start, i)));
  }
  const isoToday = iso(TODAY);
  const chargeMonth = (p) => (p.charge_date || p.expected_delivery || "").slice(0, 7) || null;
  function computeMoney(r, projects, internal) {
    const base = +r.monthly_value, carryMonths = +(r.carry_over_months ?? 1);
    const tl = timeline(r);
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
    const contractValue = base * firmRows.length, withinTotal = firmRows.reduce((s, x) => s + x.within, 0);
    const current = rows.find((x) => x.state === "current");
    return { base, carryMonths, contractValue, contractValueWithOption: base * rows.length, used: rows.reduce((s, x) => s + x.used, 0), within: withinTotal, overage: rows.reduce((s, x) => s + x.overage, 0), remaining: contractValue - withinTotal, released: base * elapsed.length, availableNow: current ? current.allowance - current.used : 0, current, expired: rows.filter((x) => x.state === "past").reduce((s, x) => s + x.expired, 0), unallocated, rows, tl, pctUsed: contractValue ? withinTotal / contractValue : 0, pctTime: tl.contract.pct, paid: Object.values(paid).reduce((a, b) => a + b, 0), invoiced: Object.values(invoiced).reduce((a, b) => a + b, 0) };
  }
  function health(m) {
    if (m.tl.phase === "before start") return { k: "neutral", t: "Starts " + fmtShort(iso(m.tl.start)) };
    if (m.tl.phase === "ended") return { k: "neutral", t: "Ended" };
    const committedShare = m.contractValue ? m.used / m.contractValue : 0;
    if (m.overage > 0) return { k: "bad", t: "Over allowance" };
    if (committedShare > m.pctTime + 0.25) return { k: "warn", t: "Ahead of pace" };
    if (committedShare < m.pctTime - 0.25) return { k: "warn", t: "Under-used" };
    return { k: "good", t: "On track" };
  }

  /* ---------------- rendering helpers ---------------- */
  const h = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].join("") : vals[i] ?? "") : ""), "");
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
    const extLabel = tl.status === "taken" ? "Extension · confirmed" : tl.status === "declined" ? "Extension · not taken" : `Extension · ${r.extension_months}-month option`;
    return h`<div class="timeline">
      <div class="timeline__track">
        <div class="timeline__seg timeline__seg--initial" style="width:${iw}%"><span class="timeline__seglabel">Initial term · ${r.initial_months} months</span></div>
        <div class="timeline__seg timeline__seg--ext ${tl.status}" style="width:${ew}%"><span class="timeline__seglabel">${extLabel}</span></div>
        ${doneW > 0 && tl.phase !== "before start" ? `<div class="timeline__done" style="width:${Math.min(doneW, tl.status === "taken" ? 100 : iw)}%"></div>` : ""}
        ${decPos !== null && tl.phase !== "ended" ? `<div class="timeline__mark" style="left:${decPos}%" data-label="Decide by ${fmtShort(iso(tl.decisionBy))}"></div>` : ""}
        ${tl.phase !== "ended" && tl.phase !== "before start" ? `<div class="timeline__today" style="left:${todayPos}%" data-label="Today"></div>` : ""}
      </div>
      <div class="timeline__dates"><span>${fmtDate(iso(tl.start))}</span><span>${fmtDate(iso(tl.initialEnd))}</span><span>${fmtDate(iso(tl.extEnd))}</span></div>
      <div class="timeline__months">${monthsAll.map((m) => `<span>${mlabel(m)}</span>`)}</div>
    </div>
    <div class="timeline__legend"><span>■ Initial · ${r.initial_months} mo</span><span>▨ ${extLabel.replace("Extension · ", "Ext. ")}</span>${tl.decisionBy ? `<span style="color:var(--warn)">| Decide by ${fmtShort(iso(tl.decisionBy))}</span>` : ""}</div>`;
  }

  function moneyChart(m) {
    const rows = m.rows, W = 760, H = 260, padL = 54, padR = 12, padT = 28, padB = 36;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(...rows.map((r) => Math.max(r.allowance, r.used)), m.base) * 1.15;
    const y = (v) => padT + innerH - (v / max) * innerH;
    const slot = innerW / rows.length, bw = Math.min(56, slot * 0.58);
    const ticks = 4; let grid = "";
    for (let i = 0; i <= ticks; i++) { const v = (max / ticks) * i; grid += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? "£" + Math.round(v / 1000) + "k" : "£" + Math.round(v)}</text>`; }
    let bars = "";
    rows.forEach((r, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const top = y(r.allowance), base = y(0);
      bars += `<rect class="bar-track ${r.firm ? "" : "option"}" x="${x}" y="${top}" width="${bw}" height="${Math.max(0, base - top)}" rx="4"/>`;
      if (r.used > 0) {
        const within = Math.min(r.used, r.allowance);
        const fromCarry = Math.min(within, r.carry_in);          // carried money is spent first
        const fromBase = within - fromCarry;
        const yWithin = y(within);
        if (fromBase > 0) bars += `<rect class="bar-used" x="${x}" y="${y(fromBase)}" width="${bw}" height="${Math.max(0, base - y(fromBase))}" rx="4"/>`;
        if (fromCarry > 0) bars += `<rect class="bar-carry" x="${x}" y="${yWithin}" width="${bw}" height="${Math.max(0, y(fromBase) - yWithin - (fromBase > 0 ? 2 : 0))}" rx="4"/>`;
        if (r.overage > 0) { const yo = y(r.used); bars += `<rect class="bar-over" x="${x}" y="${yo}" width="${bw}" height="${Math.max(0, y(r.allowance) - yo - 2)}" rx="4"/><text class="label over" x="${x + bw / 2}" y="${yo - 6}" text-anchor="middle">+${money(r.overage)}</text>`; }
        else bars += `<text class="label" x="${x + bw / 2}" y="${Math.min(yWithin, top) - 6}" text-anchor="middle">${money(r.used)}</text>`;
      }
      bars += `<text class="axis" x="${x + bw / 2}" y="${H - 12}" text-anchor="middle">${r.label}</text>`;
      if (r.state === "current") bars += `<rect class="current-pill" x="${x + bw / 2 - 26}" y="${padT - 26}" width="52" height="16" rx="8"/><text class="current-text" x="${x + bw / 2}" y="${padT - 14.5}" text-anchor="middle">NOW</text>`;
      bars += `<rect class="hit" data-i="${i}" x="${padL + slot * i}" y="${padT - 28}" width="${slot}" height="${innerH + 28}"/>`;
    });
    return `<div class="chart" id="money-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Allowance and work charged by month">${grid}<line class="baseline" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>${bars}</svg><div class="tooltip" id="money-tip"></div></div>
      <div class="legend"><span><i class="track"></i>Allowance (incl. carry-over)</span><span><i class="option"></i>Option months, not yet firm</span><span><i class="used"></i>Work charged</span><span><i class="carry"></i>Paid from carry-over</span><span><i class="over"></i>Over allowance, billed on top</span></div>`;
  }
  function wireChart(m) {
    const chart = document.getElementById("money-chart"); if (!chart) return;
    const tip = document.getElementById("money-tip");
    chart.querySelectorAll(".hit").forEach((el) => {
      el.addEventListener("mouseenter", (e) => {
        const r = m.rows[+el.dataset.i];
        tip.innerHTML = `<b>${esc(new Date(r.month + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }))}${r.firm ? "" : " · option"}</b>
          <div class="row"><span>Monthly value</span><em>${money(r.base)}</em></div>
          <div class="row"><span>Carried in</span><em>${money(r.carry_in)}</em></div>
          <div class="row"><span>Allowance</span><em>${money(r.allowance)}</em></div>
          <div class="row"><span>Work charged</span><em>${money(r.used)}</em></div>
          ${r.overage ? `<div class="row"><span>Over allowance</span><em>${money(r.overage)}</em></div>` : `<div class="row"><span>Unused → next month</span><em>${money(r.unused)}</em></div>`}
          ${r.projects.length ? `<div class="row" style="margin-top:6px;color:rgba(255,255,255,.55)"><span>${r.projects.map((p) => esc(p.name)).join("<br>")}</span></div>` : ""}`;
        tip.classList.add("show");
      });
      el.addEventListener("mousemove", (e) => { const b = chart.getBoundingClientRect(); tip.style.left = (e.clientX - b.left) + "px"; tip.style.top = Math.max(0, e.clientY - b.top - tip.offsetHeight - 14) + "px"; });
      el.addEventListener("mouseleave", () => tip.classList.remove("show"));
    });
  }
  function moneyTable(m) {
    return h`<div class="table-wrap"><table>
      <thead><tr><th>Month</th><th class="num">Monthly value</th><th class="num">Carried in</th><th class="num">Allowance</th><th class="num">Work charged</th><th class="num">Over allowance</th><th class="num">Carries forward</th><th>Projects</th></tr></thead>
      <tbody>${m.rows.map((r) => `<tr class="${r.state} ${r.firm ? "" : "option"}"><td><b>${r.label}</b>${r.firm ? "" : '<div class="sub">Option</div>'}${r.state === "current" ? '<div class="sub">This month</div>' : ""}</td><td class="num">${money(r.base)}</td><td class="num">${money(r.carry_in)}</td><td class="num"><b>${money(r.allowance)}</b></td><td class="num">${money(r.used)}</td><td class="num">${r.overage ? `<span class="delta delta--bad">${money(r.overage)}</span>` : "—"}</td><td class="num">${money(r.unused)}</td><td>${r.projects.map((p) => esc(p.name)).join("<br>") || "—"}</td></tr>`)}</tbody>
      <tfoot><tr><td>Firm contract</td><td class="num">${money(m.contractValue)}</td><td></td><td></td><td class="num">${money(m.used)}</td><td class="num">${m.overage ? money(m.overage) : "—"}</td><td class="num">${money(m.remaining)} left</td><td></td></tr></tfoot>
    </table></div>`;
  }

  function projectCard(p, internal) {
    const int = internal?.projects?.[p.id];
    return h`<article class="card pcard">
      ${p.pinned ? `<span class="pin" title="Pinned"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3l5 5-4 1-3.5 3.5.5 5.5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5.5.5L14 7z"/></svg></span>` : ""}
      <div class="pcard__top">${pill(p.status)}<span class="pcard__dept">${esc(p.department || "")}</span></div>
      <h3>${esc(p.name)}</h3>
      ${p.summary ? `<p class="pcard__sum">${esc(p.summary)}</p>` : ""}
      ${p.deliverables?.length ? `<div class="tags">${p.deliverables.map((d) => `<span class="tag">${esc(d)}</span>`).join("")}</div>` : ""}
      <div class="pcard__meta"><div><span>Expected delivery</span><b>${fmtDate(p.expected_delivery)}</b></div><div><span>Cost to retainer</span><b>${money(p.client_cost)}</b></div>
      ${int ? `<div><span>Cost to Mood</span><b>${money(int.cost_to_mood)}</b></div><div><span>Margin</span><b>${p.client_cost ? pct((p.client_cost - int.cost_to_mood) / p.client_cost) : "—"}</b></div>` : ""}</div>
      ${p.next_step ? `<p class="pcard__next">${esc(p.next_step)}</p>` : ""}
      <div class="pcard__actions">${p.frame_link ? `<a class="btn btn--ink btn--sm" href="${esc(p.frame_link)}" target="_blank" rel="noopener">Latest draft ${extIcon}</a>` : `<span class="faint" style="font-size:13px">Draft link appears here when there's a cut to review</span>`}</div>
    </article>`;
  }

  /* ---------------- views ---------------- */
  function renderGate(manifest, error = "") {
    $root.innerHTML = h`<div class="gate">
      <section class="gate__brand">
        <img class="gate__logo" src="assets/logo/mood-white.png" alt="Mood Studio">
        <div><h1 class="gate__headline">Your films, <em>your numbers,</em> one place.</h1><p class="gate__sub">Live project status, retainer allowance and every delivered film for your team. Sign in with the details Mood Studio sent you.</p></div>
        <div class="gate__foot"><span>Mood Studio</span><span>Leeds &amp; London</span><span>moodstudio.co</span></div>
      </section>
      <section class="gate__form"><form class="gate__card fade-in" id="login" autocomplete="on">
        <span class="eyebrow">Client hub</span><h2>Sign in</h2>
        <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
        <div class="field"><label for="p">Passcode</label><div class="pwwrap"><input id="p" name="password" type="password" autocomplete="current-password" required><button type="button" id="toggle-pw">Show</button></div></div>
        <div class="gate__error" id="err">${esc(error)}</div>
        <button class="btn btn--lime btn--block" id="go" type="submit">Open dashboard</button>
        <p class="gate__hint">Lost your passcode? Email <a href="mailto:hello@moodfilms.co.uk" style="color:#fff">hello@moodfilms.co.uk</a>.</p>
      </form></section></div>`;
    document.getElementById("toggle-pw").onclick = (e) => { const i = document.getElementById("p"); i.type = i.type === "password" ? "text" : "password"; e.target.textContent = i.type === "password" ? "Show" : "Hide"; };
    document.getElementById("login").onsubmit = async (e) => {
      e.preventDefault(); const btn = document.getElementById("go"), err = document.getElementById("err");
      btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
      try { await login(manifest, e.target.username.value, e.target.password.value); route(); }
      catch (ex) { err.textContent = ex.message || "Could not sign in."; btn.disabled = false; btn.textContent = "Open dashboard"; }
    };
    setTimeout(() => document.getElementById("u")?.focus(), 50);
  }

  function shell(inner, { client = null, tabs = [], active = "", crumbs = "" } = {}) {
    const isTeam = session.kind === "team";
    document.documentElement.style.setProperty("--accent", client?.client?.accent || "#2175D9");
    document.documentElement.style.setProperty("--accent-soft", (client?.client?.accent || "#2175D9") + "1f");
    $root.innerHTML = h`<div class="app">
      <header class="topbar"><div class="topbar__in">
        <a href="#/" title="Mood Studio"><img class="topbar__logo" src="assets/logo/mood-white.png" alt="Mood Studio"></a>
        ${client ? `<span class="topbar__sep"></span><span class="topbar__client"><i class="dot"></i>${esc(client.client.name)}<span class="faint" style="font-weight:600">· ${esc(client.client.tagline || "Client hub")}</span></span>` : ""}
        <span class="topbar__spacer"></span>
        ${isTeam ? `<span class="chip chip--lime">Team view</span>` : ""}
        <span class="topbar__user">Signed in as <b>${esc(session.label)}</b><button class="linkbtn" id="logout">Sign out</button></span>
      </div>
      ${tabs.length ? `<nav class="subnav"><div class="subnav__in" role="tablist">${tabs.map((t) => `<button class="tab ${t.internal ? "tab--internal" : ""}" role="tab" aria-selected="${t.id === active}" data-href="${t.href}">${t.label}${t.count != null ? `<span class="count">${t.count}</span>` : ""}</button>`).join("")}</div></nav>` : ""}
      </header>
      <main class="main fade-in">${inner}</main>
      <footer class="footer"><span>Mood Studio Limited · hello@moodfilms.co.uk · Leeds &amp; London</span><span>Figures updated ${esc(fmtDate(session.builtAt?.slice(0, 10)))}${client?.synced_at ? " · synced from Monday " + esc(fmtDate(client.synced_at.slice(0, 10))) : ""}</span></footer>
    </div>`;
    document.getElementById("logout").onclick = logout;
    $root.querySelectorAll(".tab").forEach((b) => (b.onclick = () => (location.hash = b.dataset.href)));
  }

  function renderPortfolio() {
    const slugs = Object.keys(session.clients).sort();
    const cards = slugs.map((slug) => {
      const c = session.clients[slug], m = computeMoney(c.retainer, c.projects, session.internal[slug]);
      const hl = health(m), live = c.projects.filter((p) => !DONE.has(p.status)).length;
      return h`<button class="pfcard" data-slug="${slug}" style="--accent:${esc(c.client.accent || "#2175D9")}">
        <div class="pfcard__top"><span class="pfcard__name"><i class="dot"></i>${esc(c.client.name)}</span><span class="health health--${hl.k}">${hl.t}</span></div>
        <div><div class="meter"><i style="width:${Math.min(100, m.contractValue ? (m.used / m.contractValue) * 100 : 0)}%"></i></div><div class="meter-row"><span>${money(m.used)} committed of ${money(m.contractValue)}</span><span>${pct(m.pctTime)} of term</span></div></div>
        <div class="pfcard__stats"><div><span>Phase</span><b style="font-size:14px;text-transform:capitalize">${m.tl.phase}</b></div><div><span>Live projects</span><b>${live}</b></div><div><span>Available now</span><b>${money(Math.max(0, m.availableNow))}</b></div></div>
        ${c.sample ? `<span class="chip chip--warn" style="align-self:flex-start">Sample figures</span>` : ""}
      </button>`;
    });
    const totals = slugs.reduce((t, s) => { const c = session.clients[s]; const m = computeMoney(c.retainer, c.projects, session.internal[s]); t.contract += m.contractValue; t.used += m.used; t.live += c.projects.filter((p) => !DONE.has(p.status)).length; return t; }, { contract: 0, used: 0, live: 0 });
    shell(h`<div class="page-head"><div><span class="eyebrow">Mood Studio · internal</span><h1>Client dashboards</h1><p class="lead">Every retainer and project hub in one place. Open a client to see exactly what they see, plus the internal tab with cost and margin.</p></div>
      <div class="page-head__actions"><span class="chip chip--warn" hidden></span></div></div>
      <div class="grid grid--4" style="margin-bottom:28px">${stat("Clients", slugs.length, "with a live hub", "card--ink")}${stat("Contract value", money(totals.contract), "firm months across all retainers")}${stat("Committed", money(totals.used), "work charged to allowances")}${stat("Live projects", totals.live, "not yet delivered")}</div>
      <div class="section"><div class="section__head"><div><span class="eyebrow">Portals</span><h2>Clients</h2></div></div>
      <div class="pf">${cards}<div class="pfcard pfcard--add">Add a client: new entry in config/clients.json + data/&lt;slug&gt;.json, then rebuild</div></div></div>`, {});
    $root.querySelectorAll(".pfcard[data-slug]").forEach((b) => (b.onclick = () => (location.hash = "#/c/" + b.dataset.slug)));
  }

  function renderClient(slug, tab = "overview") {
    const c = session.clients[slug]; if (!c) { location.hash = "#/"; return; }
    const isTeam = session.kind === "team", internal = isTeam ? session.internal[slug] : null;
    const m = computeMoney(c.retainer, c.projects, internal), tl = m.tl, hl = health(m);
    const live = c.projects.filter((p) => !DONE.has(p.status)), delivered = c.projects.filter((p) => DONE.has(p.status));
    const tabs = [
      { id: "overview", label: "Overview", href: `#/c/${slug}` }, { id: "money", label: "Retainer & money", href: `#/c/${slug}/money` },
      { id: "projects", label: "Projects", href: `#/c/${slug}/projects`, count: live.length }, { id: "library", label: "Delivered films", href: `#/c/${slug}/library`, count: c.library?.length || 0 },
      { id: "brief", label: "Brief a film", href: `#/c/${slug}/brief` },
    ];
    if (isTeam) tabs.push({ id: "internal", label: "Internal", href: `#/c/${slug}/internal`, internal: true });
    const sampleBanner = c.sample ? `<div class="banner">${warnIcon}<span>Sample figures. The retainer value, dates and project costs are placeholders until the signed scope is entered in <b>data/${esc(slug)}.json</b>.</span></div>` : "";
    const backLink = isTeam ? `<a class="btn btn--ghost btn--sm" href="#/">← All clients</a>` : "";

    let body = "";
    if (tab === "overview") {
      const pinned = c.projects.filter((p) => p.pinned), rest = live.filter((p) => !p.pinned).sort((a, b) => (a.expected_delivery || "9999").localeCompare(b.expected_delivery || "9999"));
      const top = [...pinned, ...rest].slice(0, 3);
      const nextDelivery = rest.concat(pinned).filter((p) => p.expected_delivery >= isoToday).sort((a, b) => a.expected_delivery.localeCompare(b.expected_delivery))[0];
      body = h`${sampleBanner}
      <div class="page-head"><div><span class="eyebrow">${esc(c.retainer.name)}</span><h1>Hello, ${esc(c.client.name)}.</h1><p class="lead">${tl.phase === "before start" ? `Your retainer starts on ${fmtDate(iso(tl.start))}. ${live.length} project${live.length === 1 ? " is" : "s are"} already being lined up.` : tl.phase === "ended" ? "This retainer has ended. Everything delivered is in the library." : `You are ${tl.contract.days_done} days into your ${tl.monthsTotal}-month term with ${live.length} project${live.length === 1 ? "" : "s"} in flight.`}</p></div>
        <div class="page-head__actions">${backLink}<a class="btn btn--ink" href="#/c/${slug}/brief">Brief a new film</a></div></div>
      <div class="grid grid--4">
        ${m.current ? stat("Available this month", money(Math.max(0, m.availableNow)), `${money(m.current.carry_in)} carried in · <span class="delta delta--${m.current.overage ? "bad" : "good"}">${m.current.overage ? "Over by " + money(m.current.overage) : money(m.current.used) + " charged"}</span>`, "card--ink") : tl.phase === "before start" ? stat("First month's allowance", money(m.rows[0]?.allowance || m.base), `from ${fmtDate(iso(tl.start))} · ${money(m.rows[0]?.used || 0)} already planned`, "card--ink") : stat("Available this month", "—", "Outside the contract period", "card--ink")}
        ${stat("Committed to date", money(m.used), `<span class="delta delta--${hl.k}">${hl.t}</span> · ${pct(m.contractValue ? m.used / m.contractValue : 0)} of the firm contract`)}
        ${stat("Live projects", live.length, `${delivered.length} delivered under this retainer`)}
        ${stat("Next delivery", nextDelivery ? fmtShort(nextDelivery.expected_delivery) : "—", nextDelivery ? esc(nextDelivery.name) : "Nothing scheduled")}
      </div>
      <div class="grid grid--main section">
        <section class="card"><div class="card__head"><h2>Contract timeline</h2><span class="phase"><i></i>${tl.phase[0].toUpperCase() + tl.phase.slice(1)}</span></div>${timelineHTML(tl, c.retainer)}
          <dl class="kv" style="margin-top:36px"><dt>Monthly value</dt><dd>${money(m.base)}</dd><dt>Firm contract</dt><dd>${money(m.contractValue)} · ${c.retainer.initial_months} months</dd><dt>If the option is taken</dt><dd>${money(m.contractValueWithOption)} · ${+c.retainer.initial_months + +c.retainer.extension_months} months</dd>${tl.decisionBy ? `<dt>Extension decision by</dt><dd>${fmtDate(iso(tl.decisionBy))}</dd>` : ""}</dl></section>
        <section class="card"><div class="card__head"><h2>How the allowance works</h2></div>
          <div class="steps"><div class="step"><div><b>${money(m.base)} a month</b>to spend on films, in any mix of projects.</div></div><div class="step"><div><b>Unused money rolls into the next month</b>then expires, so a quiet month can fund a bigger one.</div></div><div class="step"><div><b>Anything over the allowance is billed on top</b>and shown clearly here before it happens.</div></div></div>
          <p class="muted" style="margin-top:18px;font-size:13px">${esc(c.retainer.terms || "")}</p></section>
      </div>
      <div class="section"><div class="section__head"><div><span class="eyebrow">In flight</span><h2>Where your projects are</h2></div><a class="btn btn--ghost btn--sm" href="#/c/${slug}/projects">All projects →</a></div>
        ${top.length ? `<div class="grid grid--3">${top.map((p) => projectCard(p, internal)).join("")}</div>` : `<div class="empty">No live projects yet. Brief one and it appears here.</div>`}</div>
      <div class="grid grid--2 section">
        <section class="card"><div class="card__head"><h2>Latest from Mood</h2></div>${c.updates?.length ? `<div class="feed">${c.updates.map((u) => `<div class="feed__item"><time>${fmtShort(u.date)}</time><p>${esc(u.text)}</p></div>`).join("")}</div>` : `<div class="empty">Updates will appear here.</div>`}</section>
        <section class="card"><div class="card__head"><h2>Your team at Mood</h2></div>
          <dl class="kv"><dt>Your producer</dt><dd>${esc(c.client.mood_lead?.name || "Mood Studio")}</dd><dt>Email</dt><dd><a href="mailto:${esc(c.client.mood_lead?.email || "hello@moodfilms.co.uk")}">${esc(c.client.mood_lead?.email || "hello@moodfilms.co.uk")}</a></dd><dt>Working on your account</dt><dd>${(c.client.mood_team || []).map(esc).join(", ")}</dd><dt>Response time</dt><dd>${esc(c.briefing?.turnaround || "Two working days")}</dd></dl>
          <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn btn--ink btn--sm" href="mailto:${esc(c.client.mood_lead?.email || "hello@moodfilms.co.uk")}">Email ${esc((c.client.mood_lead?.name || "Mood").split(" ")[0])}</a><a class="btn btn--ghost btn--sm" href="#/c/${slug}/brief">Brief a film</a></div></section>
      </div>`;
    }
    if (tab === "money") {
      body = h`${sampleBanner}
      <div class="page-head"><div><span class="eyebrow">${esc(c.retainer.name)}</span><h1>Retainer &amp; money</h1><p class="lead">Month by month: what the allowance is, what has been charged against it, and what carries forward.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="grid grid--4">
        ${stat("Firm contract", money(m.contractValue), `${money(m.base)} × ${c.retainer.initial_months} months`, "card--ink")}
        ${stat("Committed", money(m.used), `${money(m.remaining)} still to use`)}
        ${stat("Carried over", money(m.current?.carry_in || 0), m.current ? "into this month" : "—")}
        ${stat("Over allowance", money(m.overage), m.overage ? `<span class="delta delta--bad">Billed on top</span>` : `<span class="delta delta--good">Nothing extra to bill</span>`)}
      </div>
      <section class="card section"><div class="card__head"><div><span class="eyebrow">Allowance vs work charged</span><h2>By month</h2></div><span class="faint" style="font-size:13px">Hover a month for the breakdown</span></div>${moneyChart(m)}</section>
      <section class="card section"><div class="card__head"><h2>The ledger</h2>${m.unallocated ? `<span class="chip chip--warn">${money(m.unallocated)} not yet dated</span>` : ""}</div>${moneyTable(m)}</section>`;
    }
    if (tab === "projects") {
      body = h`${sampleBanner}
      <div class="page-head"><div><span class="eyebrow">${esc(c.client.name)}</span><h1>Projects</h1><p class="lead">Every film under the retainer, from first brief to delivery.</p></div><div class="page-head__actions">${backLink}<a class="btn btn--ink" href="#/c/${slug}/brief">Brief a new film</a></div></div>
      <div class="filters" id="pfilters"><button class="fchip" aria-pressed="true" data-f="all">All <span class="faint">${c.projects.length}</span></button><button class="fchip" aria-pressed="false" data-f="live">Live <span class="faint">${live.length}</span></button>${STATUSES.filter((s) => c.projects.some((p) => p.status === s)).map((s) => `<button class="fchip" aria-pressed="false" data-f="${esc(s)}">${esc(s)}</button>`).join("")}</div>
      <div class="grid grid--3 section" id="pcards" style="margin-top:20px"></div>
      <section class="card section"><div class="card__head"><h2>All projects</h2></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Team</th><th>Status</th><th>Expected delivery</th><th class="num">Cost</th>${internal ? '<th class="num">Cost to Mood</th>' : ""}<th>Draft</th></tr></thead><tbody id="prows"></tbody></table></div></section>`;
    }
    if (tab === "library") {
      body = h`<div class="page-head"><div><span class="eyebrow">${esc(c.client.name)}</span><h1>Delivered films</h1><p class="lead">Everything Mood has made with ${esc(c.client.name)}, with links to the published case studies.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="lib">${(c.library || []).map((f) => `<a class="libcard" href="${esc(f.url)}" target="_blank" rel="noopener"><span class="play"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span><span class="eyebrow">${esc(f.type)} · ${esc(f.year)}</span><h3>${esc(f.name)}</h3><p>${esc(f.summary || "")}</p></a>`).join("")}
      ${delivered.map((p) => `<a class="libcard" href="${esc(p.frame_link || "#")}" ${p.frame_link ? 'target="_blank" rel="noopener"' : ""}><span class="eyebrow">Delivered · ${fmtShort(p.expected_delivery)}</span><h3>${esc(p.name)}</h3><p>${esc(p.summary || "")}</p></a>`).join("")}</div>
      ${!(c.library || []).length && !delivered.length ? `<div class="empty">Delivered films will be collected here.</div>` : ""}`;
    }
    if (tab === "brief") {
      const b = c.briefing || {};
      body = h`<div class="page-head"><div><span class="eyebrow">${esc(c.client.name)}</span><h1>Brief a film</h1><p class="lead">A brief is a description of a problem, not a specification for a film. Tell us what should be different after people watch it, and who has to act. We'll propose the right film.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="grid grid--main">
        <section class="card card--ink"><div class="card__head"><h2>Three steps</h2></div>
          <div class="steps"><div class="step" style="color:rgba(255,255,255,.75)"><div><b style="color:#fff">Download the briefing form</b>Twelve short questions, about fifteen minutes. “Don't know yet” is a fine answer.</div></div><div class="step" style="color:rgba(255,255,255,.75)"><div><b style="color:#fff">Send it to your marketing contact</b>They check it against the retainer plan and pass it to Mood, or send it straight to us if it's already approved.</div></div><div class="step" style="color:rgba(255,255,255,.75)"><div><b style="color:#fff">Options, quote and timeline</b>${esc(b.turnaround || "Back to you within two working days.")}</div></div></div>
          <div style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">${b.form_url ? `<a class="btn btn--lime" href="${esc(b.form_url)}" target="_blank" rel="noopener">Download the briefing form</a>` : ""}<a class="btn btn--ghost on-dark" href="mailto:${esc(b.send_to || "hello@moodfilms.co.uk")}?subject=${encodeURIComponent("New film brief — " + c.client.name)}">Email a brief</a></div></section>
        <section class="card"><div class="card__head"><h2>The two questions that decide everything</h2></div>
          <div class="steps"><div class="step"><div><b>What should be different after people watch it?</b>More applicants for a hard-to-fill role, a team that understands a new process, a client who renews. One sentence.</div></div><div class="step"><div><b>Who has to act, and what do they think today?</b>Name the audience precisely. “Everyone” is not a brief.</div></div></div>
          <p class="muted" style="margin-top:18px;font-size:13px">Start with the outcome, not the format. Where the film lives decides the length, and a 15-second cut and a two-minute film often come from the same shoot.</p></section>
      </div>
      <div class="section"><div class="section__head"><div><span class="eyebrow">What's possible</span><h2>Kinds of film</h2></div></div>
        <div class="formats">${(b.formats || []).map((f) => `<div class="format"><h4>${esc(f.name)}</h4><p>${esc(f.best_for)}</p><p>${esc(f.shape)}</p></div>`).join("")}</div></div>`;
    }
    if (tab === "internal" && isTeam) {
      const int = internal || { projects: {}, risks: [], notes: "" };
      const costTotal = c.projects.reduce((s, p) => s + (+int.projects?.[p.id]?.cost_to_mood || 0), 0);
      const revenue = m.within + m.overage, gp = revenue - costTotal;
      body = h`<div class="page-head"><div><span class="eyebrow" style="color:var(--magenta)">Mood only · never shown to the client</span><h1>Internal view</h1><p class="lead">What this retainer is costing Mood, project by project, and what still needs invoicing.</p></div><div class="page-head__actions">${backLink}</div></div>
      <div class="grid grid--4">
        ${stat("Revenue to date", money(revenue), "within allowance + overage", "card--ink")}
        ${stat("Cost to Mood", money(costTotal), "estimated or booked costs")}
        ${stat("Gross profit", money(gp), `<span class="delta delta--${gp / (revenue || 1) >= 0.4 ? "good" : gp > 0 ? "warn" : "bad"}">${revenue ? pct(gp / revenue) + " margin" : "No revenue yet"}</span>`)}
        ${stat("Overage to invoice", money(m.overage), m.overage ? `<span class="delta delta--warn">Raise on top of the retainer</span>` : "Nothing outside the allowance")}
      </div>
      <div class="grid grid--main section">
        <section class="card"><div class="card__head"><h2>Margin by project</h2></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th class="num">Charged</th><th class="num">Cost to Mood</th><th class="num">Margin</th><th>Note</th></tr></thead>
          <tbody>${c.projects.map((p) => { const i = int.projects?.[p.id] || {}; const mg = p.client_cost ? (p.client_cost - (+i.cost_to_mood || 0)) / p.client_cost : null; return `<tr><td><b>${esc(p.name)}</b></td><td>${pill(p.status)}</td><td class="num">${money(p.client_cost)}</td><td class="num">${i.cost_to_mood != null ? money(i.cost_to_mood) : "—"}</td><td class="num">${mg == null ? "—" : `<span class="delta delta--${mg >= 0.4 ? "good" : mg > 0.2 ? "warn" : "bad"}">${pct(mg)}</span>`}</td><td><div class="sub">${esc(i.note || "")}</div></td></tr>`; }).join("")}</tbody></table></div></section>
        <div style="display:grid;gap:16px">
          <section class="card"><div class="card__head"><h3>Account notes</h3></div><p class="internal-note">${esc(int.notes || "No notes yet.")}</p></section>
          <section class="card"><div class="card__head"><h3>Watch-outs</h3></div>${(int.risks || []).length ? int.risks.map((r) => `<div class="risk">${esc(r)}</div>`).join("") : '<p class="faint">None logged.</p>'}</section>
          <section class="card"><div class="card__head"><h3>Billing</h3></div><dl class="kv"><dt>Invoiced (Xero)</dt><dd>${money(m.invoiced)}</dd><dt>Paid</dt><dd>${money(m.paid)}</dd><dt>Expired carry-over</dt><dd>${money(m.expired)}</dd><dt>Client login</dt><dd>${esc(slug)}</dd></dl></section>
        </div></div>`;
    }
    shell(body, { client: c, tabs, active: tab });
    if (tab === "money") wireChart(m);
    if (tab === "projects") {
      const draw = (f) => {
        const list = c.projects.filter((p) => f === "all" || (f === "live" ? !DONE.has(p.status) : p.status === f)).sort((a, b) => (b.pinned - a.pinned) || (a.expected_delivery || "9999").localeCompare(b.expected_delivery || "9999"));
        document.getElementById("pcards").innerHTML = list.length ? list.map((p) => projectCard(p, internal)).join("") : `<div class="empty" style="grid-column:1/-1">Nothing here.</div>`;
        document.getElementById("prows").innerHTML = list.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.summary ? `<div class="sub">${esc(p.summary)}</div>` : ""}</td><td>${esc(p.department || "—")}</td><td>${pill(p.status)}</td><td>${fmtDate(p.expected_delivery)}</td><td class="num">${money(p.client_cost)}</td>${internal ? `<td class="num">${internal.projects?.[p.id] ? money(internal.projects[p.id].cost_to_mood) : "—"}</td>` : ""}<td>${p.frame_link ? `<a class="tbl-link" href="${esc(p.frame_link)}" target="_blank" rel="noopener">Open ↗</a>` : "—"}</td></tr>`).join("");
      };
      draw("all");
      document.getElementById("pfilters").querySelectorAll(".fchip").forEach((b) => (b.onclick = () => { document.querySelectorAll("#pfilters .fchip").forEach((x) => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); draw(b.dataset.f); }));
    }
    window.scrollTo({ top: 0 });
  }

  /* ---------------- router ---------------- */
  let manifest = null;
  function route() {
    if (!session.kind) return renderGate(manifest);
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (session.kind === "client") {
      const slug = Object.keys(session.clients)[0];
      if (parts[0] !== "c" || parts[1] !== slug) { location.hash = `#/c/${slug}`; return; }
      return renderClient(slug, parts[2] === "internal" ? "overview" : parts[2] || "overview");
    }
    if (parts[0] === "c" && parts[1]) return renderClient(parts[1], parts[2] || "overview");
    renderPortfolio();
  }
  window.addEventListener("hashchange", route);
  (async () => {
    try { manifest = await (await fetch("data/manifest.json", { cache: "no-store" })).json(); }
    catch { $root.innerHTML = `<p style="padding:40px">The hub hasn't been built yet. Run <code>npm run build</code>.</p>`; return; }
    await restoreSession(manifest);
    route();
  })();
})();
