# Mood Client Hub

One passcode-locked site, one dashboard per client, and a team login that sees everything.
Built for the Randstad retainer first; any client is a new entry in the config plus a data file.

Live: https://moodfilms.github.io/mood-client-hub/

## How access works

| Who | Username | Sees |
|---|---|---|
| Mood team | `mood` | the portfolio page, every client portal, and each client's **Internal** tab (cost to Mood, margin, overage to invoice, notes) |
| A client | their own, e.g. `randstad` | only their portal: Overview, Retainer & money, Projects, Delivered films, Brief a film |

The host (GitHub Pages) only ever stores ciphertext. Every client's data is encrypted
(AES-256-GCM) with a random key; that key is wrapped once with the client's password and once
with the team password (PBKDF2, 300k rounds). Passwords and plaintext data live only in this
folder on the Mac and are git-ignored, so the public repository holds code and encrypted bundles
and nothing else. Usernames are hashed in the manifest, so the client list is not visible either.

## Day to day

```
npm run build      # encrypt data/ with config/clients.json → docs/data/
npm run serve      # preview at http://localhost:8787
npm run publish    # fetch from Monday (if a token is set), build, commit, push → live in ~1 min
```

Edit `data/<slug>.json` for a client's projects, retainer terms, updates and library, and
`data/<slug>.internal.json` for Mood-only cost and notes. Rebuild and push.

## Adding a client

1. Add an entry to `config/clients.json` (slug, username, password, data paths).
2. Create `data/<slug>.json` (copy `data/randstad.json`) and optionally `data/<slug>.internal.json`.
3. `npm run publish`. Their login works immediately; the team sees the new portal on the portfolio page.

Set `"accent"` in the client block to their brand colour; it tints their portal.

## Live data from Monday

Put a Monday API token in `secrets/monday-token.txt` (or `MONDAY_TOKEN`) and the board id in
the client's `monday.board_id`. `npm run fetch` reads the board, matches columns by title
(status, department/team, delivery date, cost, Frame/draft link, summary) and rewrites the
client's project list, keeping pinned flags. To refresh hourly without touching it, run
`npm run publish` from a launchd job on the Mac.

## Retainer maths

Same rules as the Mood Project Finance tool: a monthly value, unused money carries into the next
month (then expires), carried money is spent first, anything above the month's allowance is
overage billed on top, and option months show but are not counted in the firm contract.

## Changing a password

Edit `config/clients.json` and run `npm run publish`. Every bundle is re-encrypted on each build.
