# Mood Client Hub

One passcode-locked site, one dashboard per client, and a team login that sees and edits everything.
Built for the Randstad retainer first; any client is added from the browser in a minute.

Live: https://moodfilms.github.io/ (moving to https://hub.moodstudio.co, see *Domain*)

## What it tracks

Every project Mood does, for every client, retainer or not. The team's **All projects** page lists
them all in delivery order with stage, next step, cost and margin. Each project has a rundown page
(production stages, deliverables, key dates, progress log, links, what we need from the client)
that the client can open from their hub. A client on a retainer also gets the Retainer & money tab.

## Who sees what

| Who | Username | Sees |
|---|---|---|
| Mood team | `mood` | the portfolio, every client's hub, each hub's **Internal** tab (cost to Mood, margin, notes), **Edit this hub**, and **Clients & logins** |
| A client | their own, e.g. `randstad` | only their hub: Overview, Retainer & money, Projects, Delivered films, Brief a film |

**View as client** (top bar, team only) shows a hub exactly as that client sees it, without signing out.

## Editing from the browser (the normal way)

Sign in as the team → open a client → **Edit this hub**. Change the retainer, projects, payment
schedule, updates, films, briefing details, what tabs they can see, and the Mood-only notes.
**Publish to the live site** re-encrypts the hub in your browser and commits it to GitHub; the
live site updates in about a minute. **Clients & logins** adds a client (hub + login, optionally with its first project), sets a
client's username and passcode, or removes one. Project-based is the default; tick the retainer box
for clients on a monthly allowance.

Publishing needs a GitHub token once per browser: Settings → Developer settings → Fine-grained
tokens → repository `moodfilms/moodfilms.github.io` only → Contents: Read and write. Paste it under
**Clients & logins → Settings**. It stays in that browser only.

## Editing from the Mac (optional)

```
npm run pull       # bring the live hubs down into data/ (decrypted with the team passcode)
npm run build      # encrypt data/ with config/clients.json → docs/data/
npm run serve      # preview at http://localhost:8787
npm run publish    # pull, fetch from Monday if configured, build, commit, push
```

`config/clients.json` holds the team login and any client logins you want set from the Mac. A client
with a `password` there is re-keyed from it on every build; leave the password out (or the client out
entirely) for clients whose login is managed in the browser. Always `pull` before editing `data/` so
browser edits are not overwritten; `publish` does this for you.

## Security model

GitHub Pages is a free static host, so the repository is public. It holds code and ciphertext only.
Each hub is encrypted with AES-256-GCM under a random key; that key is wrapped once with the client's
passcode and once with the team passcode (PBKDF2, 300k rounds). Passcodes are never stored. Usernames
are hashed in the manifest, so the client list is not visible either. The Mood-only bundle is wrapped
for the team key alone.

## Domain

The hub is meant to live at `hub.moodstudio.co` (moodstudio.co's DNS is on Cloudflare):

1. Cloudflare → moodstudio.co → DNS → Add record: **CNAME**, name `hub`, target `moodfilms.github.io`, proxy **DNS only**.
2. `sh scripts/domain.sh` — checks the record, sets the custom domain on GitHub Pages, commits the CNAME file.
3. GitHub issues the certificate within ~15 minutes; then `gh api -X PUT repos/moodfilms/moodfilms.github.io/pages -F https_enforced=true`.

Until step 1 is done the github.io address keeps working; after step 2 it redirects to the new one.

## Live data from Monday

Put a Monday API token in `secrets/monday-token.txt` and a board id in the client's `monday.board_id`
in `config/clients.json`; `npm run publish` then refreshes that client's project list from the board
(columns matched by title: status, department/team, delivery date, cost, Frame link, summary).

## Retainer maths

Same rules as the Mood Project Finance tool: a monthly value, unused money carries into the next
month (then expires), carried money is spent first, anything above the month's allowance is overage
billed on top, and option months show but are not counted in the firm contract.
