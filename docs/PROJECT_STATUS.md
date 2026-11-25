# Attest — project status

Last updated: 2026-11-25

This file is the **cross-device continuity log**. Chat history does not reliably travel between phone and desktop agents. Keep this (and `AGENTS.md`) current in git.

## What this is

Local Attest e-sign app implementing the three-party data model from `docs/esign-data-model.pdf`, without Google/GCS:

| Brief | Local |
| --- | --- |
| Postgres | SQLite (`server/data/attest.sqlite`) |
| GCS | `server/data/files/**` |
| Google Identity | Email and password on the server (shared SQLite) |
| Transactional email | SMTP (or Outlook on Windows) + outbox log |

Parent brand / sending company context: **Union Payroll** — https://union-payroll.ltd/

## Working product model

### Start

After login the screen asks one question: **working from the library**, or **sending a new contract**? The header no longer lists Companies, Templates, Library and New contract.

A new contract is four steps: broker from the saved list, contract type, 3-way or 4-way, then the other parties (company, signatory, role, email). That pairing is saved into the library. The library path picks the saved broker and contractor, then asks 3-way or 4-way and the remaining parties.

Broker setup is where company details, the front cover, the back cover, and the brand SVG are added. Staff pages ask for email and password. Party signing and due-diligence links stay open. Library templates, companies and clients are rows in the server database, so any browser that can sign in sees the same records.

### Companies

- Sending-company catalog is **Union Payroll only** for now (demo companies Acme / Northwind / Contoso / Fabrikam / Adventure Works are retired / soft-deleted).
- Legal profile for Union: **UNION WORK SERVICES LIMITED (trading as Union Payroll)**, company number **16734536**, registered office International House, 22-28 Wood Street, Doncaster, United Kingdom, DN1 3LW; contact `hello@union-payroll.ltd`.
- Broker setup is company details, the person who signs, the front cover, the back cover, and the brand SVG. Brokers do not have a sending domain, from address, mailbox, or signature. Creating and baking a contract does not wait on broker domain proof.
- **Due diligence pack** follows the worked example: broker cover with the contract’s own details stamped on it, company identity, an annex index with page numbers, then the documents. The same cover stamp is applied to the contract. Companies House filings and a UK Sanctions List check are fetched from the company number for the contractor and, on a 4-way, the supplier. The person adding that company attaches only what cannot be fetched. Contractor: VAT certificate, Employers’ Liability certificate, Public Liability certificate, Professional Indemnity certificate, PI policy schedule and wording, bank statement for the account that pays workers and HMRC, illustrative payslip, and a payroll chain map with written confirmation of each PAYE reference and ERN. Supplier: HMRC PAYE registration letter, Employers’ Liability certificate, and EL policy pages naming the supplier. Received and checked dates are entered on the contract, because they change with each client. No party is emailed to supply these or to sign the pack.
- **Not built yet in the pack:** the completed due diligence declarations and the contractor director’s signed certificate “covering HMRC standing and any required disclosures” (the user’s brief; Part J of the worked example, signed there by the contractor’s director), plus the supplier’s equivalent warranties. Open decision: who signs the certificate, given no party is emailed to complete the pack.
- **Pack layout (2026-11-25):** generated cover in the worked example’s style (logo, broker name, “Due Diligence & Onboarding Pack”, “For use with the {broker} {contract}”, parties, pack reference, broker legal block), then narrative pages (company status, previous names, officers, PSCs with nature of control and ceased dates, sanctions result), then the **annex evidence index** as a table: annex letter, document, page range, received date, checked date, grouped by party. Then the documents, the broker signature page, and the broker’s back cover last. Dates print as dd/mm/yyyy. The sanctions evidence page lists every name and number searched (company, number, previous names, directors and PSCs, merged when Companies House lists the same person twice).
- The library still stores a broker, a contractor, the contract type and the cover. Staff reach it by answering “working from the library” on the start screen, not from a library form in the header.
- Each party is a company name, signee name, role (Director, or Authorised signatory) and email. The contract has a signature and a date for each party. The broker’s signature on the due diligence pack is that pack’s date.
- **Delete company** on the list and setup pages, with an in-app **Are you sure?** dialog (Cancel / Yes, delete). Soft-delete (`is_active = 0`); existing contracts stay on file.
- **Compliance company** — a third party sends the contract on behalf of the broker. The due diligence pack is built and signed in the app, not emailed out for completion. Its details, from address, mailbox, introductory email, and Gmail signature live on the broker’s Compliance company tab (and at Compliance company from the start screen). It has no Companies House number. The intro names the broker it is sent on behalf of, using `{{broker_name}}`. Opening **Good morning** / **Good afternoon** still follows the computer clock. Paste from Gmail Settings → Signature keeps formatted HTML (text, links, fonts, images).

### Templates

- **One master contract** — always included on every contract. **Open / Replace / Delete** on the Templates page (same controls as company files). Uploading the PDF scans for Client / Broker / Contractor signature and detail fields, and Supplier (SPV) when that word is on the page. Signing room lists those fields with **Jump to**.
- Bake refuses a contract when any of its parties has no signature field, and names the party. The current master is still the generated placeholder (“three-party execution”, “Company / Agency / Supplier execution blocks”); it now carries Supplier signature and date fields so 4-way contracts bake. Replace it with the real Union Payroll master contract.
- **Contract appendices** — **Add appendix** sits at the top of that section, then Open / Replace / Delete per file. If an appendix needs signing to accept those terms, the same detection and jump-to fields are added.

### Contracts

- UI word is **contract** everywhere staff see it. Internal API/SQLite still use `envelopes`.
- Draft → bake → ready → send → sequential sign → completed. **Bake again** is available while the contract is ready and unsent, so a template fix does not need a new contract.
- **3-way** (usual): Contractor, Broker, Client. **4-way** (rare): those three plus Supplier (SPV). Sign order is Contractor, Supplier when present, Broker, Client.
- The due diligence pack is built in the app. No party is emailed to complete it. Companies House and the sanctions check are fetched from the company number. Staff attach only the documents that cannot be fetched, enter the received and checked dates, compile the pack, and the broker signs it in the app. Send stays blocked until that signature.
- At signing, documents already collected for the due diligence pack are not requested again. The supplier does not re-upload incorporation or name-change certificates. What remains is Contractor director ID, Supplier director ID, and for the Client the incorporation certificate, VAT certificate, and director ID. The broker attaches nothing.
- Hash-chained audit events; baked PDF on disk.
- On completion, the signed PDF binds every requested attachment, then ends with the **audit trail** (also stored on its own): who received the file, when they signed, and their IP address, plus the event chain. All parties get that same bound copy.

## Brand / UI

- The app header is **Contract Builder**. It does not carry a broker logo. Union Payroll and E Street Management (https://es.management/) are sending companies; each contract uses that company’s own cover.
- Accent: `#0074FF`, primary buttons white text.
- Font: **Manrope**.
- Union Payroll logo asset remains available for that company’s brand pack: `client/public/union-payroll-logo.png`.
- Do **not** restyle toward Media Launch; that was a mistaken brand pass before the Union Payroll URL was provided.

## How to run

```bash
npm install
npm run build
npm start          # http://localhost:8787
```

On **Windows**, `npm start` fails because `server` uses `NODE_ENV=production node …`. Use PowerShell: `$env:NODE_ENV='production'; node src/index.js` from `server/`, or `npm run dev`.

Dev split: `npm run dev` (API 8787, Vite 5173).

### Phone / public demo (persistent workflow)

```bash
# One-time / recovery (starts API + tunnel)
bash scripts/start-live.sh
cat TUNNEL_URL.txt           # gitignored; do not commit

# Publish code changes WITHOUT changing the public URL
bash scripts/deploy-live.sh
```

Rules of the road:

- Prefer **localhost.run** `*.lhr.life` via `scripts/keep-tunnel-alive.sh`.
- Do **not** use Cloudflare `*.trycloudflare.com` quick tunnels.
- **Do not** kill/restart the tunnel during normal coding or status commits.
- Watchdog holds SSH open while local API is down (deploys); only recycles SSH if the process dies or public fails while local is healthy.
- “No tunnel here” = stale hostname after an SSH recycle — read a fresh URL from `TUNNEL_URL.txt`.
- Anonymous `*.lhr.life` hostnames still change if SSH itself dies; for a forever-stable host, add a named Cloudflare tunnel or localhost.run forever-free + SSH key later.

## Continuity tooling

- `AGENTS.md` — short agent briefing (read at session start). It also names the model for this repo: latest Claude Opus for product work, latest Claude Sonnet for a small follow-up, one model for a whole feature.
- `docs/PROJECT_STATUS.md` — this log.
- `.cursor/rules/attest-continuity.mdc` — always-apply: Contract Builder header, Union Payroll and E Street Management as sending companies, protect live tunnel, deploy-live only.
- **`/update-project-status`** — Agent slash command + skill to refresh these docs and push.

## Recent work stream (high level)

1. Local Attest stack from e-sign data model (SQLite + disk).
2. Auto covers / logo / industry appendices at bake.
3. Company setup catalog + sending-company dropdown on create.
4. Restructure to master contract + selectable industry appendices; upload/update UI.
5. Restyle to Union Payroll brand (after correcting mistaken Media Launch pass).
6. Phone tunnel: Cloudflare → localhost.run watchdog.
7. Cross-device continuity docs + Cursor rule.
8. Persistent `/update-project-status` slash command/skill.
9. Live demo persistence: `deploy-live.sh` / `start-live.sh`; watchdog ignores local downtime so URL does not change on every edit.
10. Company delete + confirm dialog; per-company intro email; Gmail signature as HTML (text + images), not image-only; UI copy uses **contract** not envelope.
11. Signing evidence is **Client + Contractor** (not company setup): address, incorporation, director, VAT; contractor also insurance. Company-setup document uploads were rolled back.
12. Master/appendix PDF upload detects per-party fields; signing room jump-to each field (appendices included when they need acceptance).
13. Templates file actions match company UX (Open / Replace / Delete + Add appendix). Domain verification is DNS TXT or emailed code, not a checkbox. Completed PDFs include an appended audit sheet (IP, opened, signed, attachments).
14. Company setup Email tab is the sending mailbox (SMTP login). From-address proof and official sends use that account; Outlook is fallback only. Superseded by item 19: the mailbox belongs to the compliance company, and broker setup has no Email tab.
15. 3-way is Contractor, Broker, Client. 4-way adds Supplier (SPV). Sign order is Contractor, Supplier, Broker, Client. Due diligence is compiled from the party documents and validated by the broker before send. Signing asks only for documents that were not in that pack: director ID for the contractor and supplier, and incorporation, VAT certificate, and director ID for the client. Broker signs with no appendix.
16. When everyone has signed, the completed PDF binds those requested attachments in sign order, then adds the audit trail as the last pages: who received the file, when they signed, and their IP address.
17. Due diligence requests go out by email. Each link opens a page of that party's document uploads. After every party submits, the broker gets a link to sign the compiled pack. That signature is what allows the contract to be sent.
18. Staff sign in with email and password. The library stores broker + contractor pairings (contract template and cover). Every party has a company, signatory, role and email, and the contract has a signature and date for each. The same SQLite database is the shared store for every browser.
19. Login opens on one question: library or new contract. A new contract asks for broker, contract type, 3-way or 4-way, then the other parties. Broker setup holds company details, covers, and the brand SVG. Mail is sent only by the compliance company, so broker setup has no sending domain, from address, mailbox, or signature. The compliance company has no Companies House number.
20. The due diligence pack is compiled in the app. Parties are not emailed a link to upload documents, and the broker is not emailed to sign. Companies House filings and the UK Sanctions List check are fetched from the company number. Staff attach only the documents that cannot be fetched, enter received and checked dates on the contract, compile the pack, and sign it from the contract. This replaces the email flow in item 17. Item 17 stays as the record of what the app used to do.
21. End-to-end test with three live Companies House companies on a 4-way Union Payroll contract (test records only; nothing sent): contractor MISSIONOPSAI LTD (14437210, formerly K-769 LTD), supplier ARC RISK MODELS LIMITED (15497898, ceased corporate PSC Arc Manco Limited), client DEVI MATA LTD. Placeholder uploads are stamped “TEST PLACEHOLDER - NOT A REAL DOCUMENT”. Fixed along the way: sanctions screening matches whole words and dedupes aliases by Unique ID, and also checks previous names and the company number; previous names, officers and PSCs (nature of control, ceased date) are stored and shown on the record and in the pack; Companies House filings keep a stable key, so received/checked dates survive a refetch; “Same dates for every document” bulk entry; dates cannot be in the future or checked before received; the dedicated DD cover, annex table and back cover described above; contract cover stamp panel is opaque; the broker’s “Sign the pack” opens inside the app (it used to jump to the API port in dev); the signature pad uses pointer events so it works with a finger on a phone; the broker signature page goes before the back cover; 4-way contracts bake (the bake used to demand exactly three parties).

## Active git / PR notes

- Feature branch naming: `cursor/<name>-59a8`.
- **Canonical branch for PC access: `main`.** Fast-forwarded 2026-08-16 with company setup, master+appendices, Union Payroll brand, localhost.run + `deploy-live.sh`, and continuity docs (was tip of `cursor/medialaunch-brand-ui-59a8` / PR **#6**).
- Desktop clone path in this session: `C:\Users\jahwo\Documents\Attest` (empty `Documents\Attext` folder is not the repo). Also cloned at `C:\Users\Shadow\Documents\Attest`.
- Superseded feature branches (safe to ignore / close after merge): PR **#5**, PR **#4**, and historical `cursor/medialaunch-brand-ui-59a8`.
- On a work PC: `git checkout main && git pull origin main`.
- `.cursor/rules/central-backup.mdc` says the live copy is the Cursor-hosted repo `origin.cursor.com/julian-holtom/attest` (remote name `cursor` in the Windows clone). Pushing there needs the origin CLI, which does not run on native Windows, so this Windows PC pushes to GitHub (`origin`) only when the user asks. The Cursor copy has one extra commit (f5ec4f1, the newer rule text), which is now in this repo’s rule file. Push to the Cursor copy from a Mac, Linux, or WSL machine with the origin CLI signed in.

## Runtime snapshot (this environment)

- Windows desktop, 2026-08-16: local API on `:8787` (`NODE_ENV=production node src/index.js` in `server/`). UI: http://localhost:8787
- Windows desktop `C:\Users\Shadow\Documents\Attest`, 2026-11-25: `npm run dev` (API :8787, UI :5173). The test contract from item 21 is baked and ready, broker-signed pack, **not sent**.
- Phone tunnel is a Linux/tmux workflow (`attest-tunnel`); do not assume it is running on this Windows box. Live URL only in `TUNNEL_URL.txt` on the host that runs the tunnel.

## Known issues / next

- [x] Phone tunnel “No tunnel here” → stale `*.lhr.life` after restart; use `TUNNEL_URL.txt`.
- [x] Continuity docs + `/update-project-status` slash entry.
- [x] Separate live deploy from tunnel lifecycle (`deploy-live.sh` / hold tunnel during local downtime).
- [x] Merge outstanding feature work to `main` (FF of PR #6 tip; #4/#5 superseded).
- [x] Delete company with Are-you-sure dialog.
- [x] Per-company intro email + Gmail signature (HTML from Gmail Settings, optional local graphic).
- [ ] Optional: stable public host (named tunnel / forever-free SSH key) so URL never changes even on SSH death.
- [x] Default New contract sending company to **Union Payroll**.
- [x] Due diligence pack is compiled in the app. Parties are not emailed to complete it. The broker signs it from the contract.
- [ ] Say “deploy to live” when phone demo should pick up new code (don’t assume every commit is live).
- [ ] Make `npm start` work on Windows (`cross-env` or equivalent).
- [ ] Due diligence declarations and the contractor director’s certificate (and supplier warranties) — decide who signs the certificate, then build it.
- [ ] Union Payroll broker library record is still flagged `is_sample = 1`, so its contracts show a SAMPLE badge and the “examples used to fill fields” note. Its saved company name reads “Union Work Services Limited ( Union Payroll)” with a stray space.
- [ ] Client company number: the worked example also checks the client at Companies House; the app does not fetch the client yet.
- [ ] The introductory email text saved on the compliance company types “Union Payroll” literally. Swap it for `{{broker_name}}` so E Street Management contracts read correctly (data, not code).
- [ ] E Street Management needs its real legal details, covers and logo.
- [ ] Upload the real Union Payroll master contract to replace the placeholder.
- [ ] Staff dates in the UI follow the browser locale (US format in some browsers); PDFs use dd/mm/yyyy.

## Continuity for humans (any device)

You do **not** need a special “quit” command.

What persists across devices:

1. **This repo on GitHub** — `AGENTS.md` + `docs/PROJECT_STATUS.md`.
2. **Cursor User Rules** — stable preferences only.
3. **Chat history** — not the source of truth across devices.

Before leaving a session: run **`/update-project-status`** (or say “update project status and push”).
