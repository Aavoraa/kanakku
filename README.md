# Kannaku AI

A keyboard-first, AI-assisted double-entry accounting app for Indian businesses (GST), built from the
[AI-First Accounting Platform spec](https://claude.ai/code/artifact/1d086c6c-3ed3-48f3-8a2a-ed11c86db758).

Uploaded documents (bills, invoices, bank statements, workings) and voice commands become **draft**
vouchers that a person confirms, or that post on their own once you switch on Auto-post. The AI never writes
to the ledger; a deterministic posting engine is the only path into it.

## Run it

Requires Node.js 22 or later. Nothing else to install: the database is PostgreSQL compiled to
WebAssembly ([PGlite](https://pglite.dev)), stored in `./data`.

**Keep the project (or at least `data`) out of OneDrive, Dropbox and Google Drive.** A sync client
rewriting the live database files can corrupt them, and `.env` holds your API key. Put the project in a
plain folder such as `C:\Projects\Kannaku`, or set `DATA_DIR=C:\KannakuData` in `.env`. The server warns
at startup when the database is in a synced folder. Only one server may use a data folder at a time; a
second one (or a script such as `reset-password`) refuses to start while the first is running.

```bash
npm install
npm start            # builds the web app and serves everything on http://127.0.0.1:4000
```

Open the page and **create an account**: your name, email and password, then your business (name,
GSTIN, state, books start date). Kannaku AI sets up that company's books with the standard 28 groups.
Tick "Also add a sample company" to get **Sharma Building Supplies** (Pune), with three months of
purchases, sales, receipts and payments, to explore alongside your own books.

- Passwords are stored as scrypt hashes; sessions are HttpOnly cookies valid for 30 days.
- Five wrong passwords lock that email for 15 minutes.
- Each account sees only its own businesses. Add more from the business name in the top bar.
- Books created before accounts existed (an older install) are added to the first account that signs up.
- `LEDGERAI_DEMO=1 npm start` pre-loads the sample company on an empty install.

For development with hot reload: `npm run dev`, then open http://localhost:5173.

### Turn on AI (bill reading and voice)

Click **AI off** in the top bar, paste your Anthropic API key (from
[console.anthropic.com → API keys](https://console.anthropic.com/settings/keys)) and press **Turn AI on**.
The key is checked with Anthropic, saved to `.env` in the project folder, and used at once; no
restart. Click **AI on** later to replace or remove it. The key serves every company on this computer,
so only the administrator (the first account created) can change it. See [Privacy](#privacy) for what is
sent to Anthropic once AI is on.

You can also put `ANTHROPIC_API_KEY=...` in `.env` yourself (see `.env.example`) and restart.
Without a key everything else works, including Excel and CSV uploads.

To try the bill-review screen without a key: stop the server, run `npm run demo:bill`, start again
and press **R** on the Gateway.

## Uploading documents

Press **Ctrl+U** (or **R** on the Gateway) and drop files. Each file becomes ready-to-post entries:

| Document | Files | Becomes | Needs AI |
| --- | --- | --- | --- |
| Purchase bill, expense receipt | PDF, photo | Purchase voucher (party, items, GST) | Yes |
| Sales invoice you issued | PDF, photo | Sales voucher (detected by your GSTIN as the seller) | Yes |
| Credit / debit notes | PDF, photo | Credit Note / Debit Note | Yes |
| Bank statement | CSV, Excel | One Receipt / Payment / Contra per line | No (PDF statements: yes) |
| Workings / journal sheet | Excel, CSV | Journal vouchers, grouped by JV number | No (free-form PDFs and photos: yes) |
| Sales or purchase register | Excel, CSV | One Sales / Purchase voucher per row, new parties created | No |

How a bank statement line is placed, in order:

1. **Already in the books?** Same bank ledger, same amount, within 3 days: marked *in books* and never posted again (uploading an overlapping statement is safe).
2. **Your earlier choice** for a similar narration (learned every time you post a line).
3. **Built-in rules:** ATM / cash deposit to Cash, bank charges, interest, salary, rent, electricity, telephone, fuel.
4. **A party named in the narration**, settling their open bill of the same amount.
5. **The AI** (when on) chooses among your existing ledgers only; anything it is unsure of waits for you.

Every proposed entry is checked by the posting engine before it is shown (dates, lock date, balance,
GST). Entries that pass are **ready**; press **Ctrl+A** to post all of them. The rest are **to check**:
pick a ledger inline, or **Edit** to open the full voucher screen. Excel files must be `.xlsx`
(re-save old `.xls` files).

**Auto-post** (Settings, off by default) posts ready entries straight after reading, up to a limit per
entry (default ₹50,000); larger ones still wait for Ctrl+A.

To try it on the sample company: `npm run samples --workspace server` writes a bank statement, a
workings sheet and a sales register to `./samples`, dated to match the demo vouchers.

### Other commands

| Command | What it does |
| --- | --- |
| `npm test` | Server tests: tax engine, posting rules, immutability, reports, voice and OCR pipelines (model mocked) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run reset-db` | Deletes `./data` (all accounts and books); the next start shows sign-up again |
| `npm run demo:bill` | Puts a sample extracted bill into the review queue (server must be stopped) |
| `npm run samples --workspace server` | Writes sample documents to `./samples` for the Documents screen |
| `npm run restore-backup -- <file>` | Replaces the database with a backup (server must be stopped); the replaced one is kept beside it. No file lists the backups |

### Backups

While the server runs it saves a copy of the whole database (every company on this computer) once a
day to `data/backups` (or `BACKUP_DIR`), keeping the last 14. The administrator can also press
**Back up now** and download a backup in Settings. Backup files are complete copies of everyone's books
and are not encrypted: keep them somewhere only you can reach, and keep one off this computer too.

`npm audit` reports a moderate advisory in `uuid`, pulled in by `exceljs`. The advisory concerns
`uuid.v3/v5/v6` with a caller-supplied buffer; exceljs only calls `uuid.v4`, so it does not apply.

## Keyboard

| Key | Action |
| --- | --- |
| F8 / F9 | Sales / Purchase |
| F5 / F6 | Payment / Receipt |
| F4 / F7 | Contra / Journal |
| Alt+F6 / Alt+F5 | Credit Note / Debit Note |
| Ctrl+A | Post (voucher entry, bill review, all ready document entries, voice confirmation) |
| F2 | Change date / period |
| Alt+C | Create a party, ledger or item from any picker |
| Ctrl+K or Alt+G | Go to any report, voucher type or ledger |
| Ctrl+U | Upload documents (bills, invoices, bank statements, workings) |
| Ctrl+Space (hold) | Talk (Chrome / Edge speech recognition; English/Hinglish or Tamil) |
| Alt+A / Alt+X | Alter / reverse the open voucher |
| Esc | Back |
| Gateway letters | D Day Book · T Trial Balance · P P&L · B Balance Sheet · A/Y Ageing · L Ledger · S Stock · G GST · M Masters · R Documents |

## How it is built

```
server/  Fastify + PGlite (TypeScript, run with tsx)
  src/db/migrations   schema: append-only ledger tables, deferred balance trigger, ltree groups, pg_trgm matching
  src/ledger          contracts (Zod), posting plans per voucher type, posting engine, masters
  src/tax             India GST engine (CGST/SGST/UTGST/IGST, inclusive pricing, round-off, RCM)
  src/inventory       FIFO and moving-average valuation (periodic: recomputed from movements for each report date)
  src/reports         trial balance, P&L, balance sheet, ageing, daybook, ledger, GST summary
  src/ai              bill extraction (Claude, structured output) + validators + resolver; voice intent engine
web/     React 19 + Vite, no UI framework; one keymap registry drives every shortcut
```

Integrity guarantees, enforced in the database as well as in code:

- Amounts are `BIGINT` paise; no floats touch money.
- `vouchers`, `ledger_entries`, `bill_allocations`, `voucher_tax_lines` and `inventory_entries` reject
  UPDATE, DELETE and TRUNCATE. Corrections are reversals; **Alter** reverses and re-posts in one transaction.
- A deferred constraint trigger rejects any voucher whose lines do not sum to zero at commit.
- Every voucher is SHA-256 hash-chained to the previous one (Settings → Verify hash chain).
- Gapless numbering per voucher type and fiscal year; idempotency keys stop double posting.
- Duplicate supplier bills, negative stock, locked periods and wrong-group parties are blocked or confirmed.

AI guardrails (spec sections 3 and 4):

- Bills: the model transcribes only; code checks GSTIN check digits, line and invoice arithmetic, tax
  split vs. place of supply, amount in words, duplicates and dates, recomputes tax with its own engine,
  and shows every finding to a reviewer before posting. Reviewer corrections teach the matcher.
- Voice: numbers are normalised deterministically (Indian English, Hindi and Tamil, lakh/crore); every amount
  the model returns must cite words that were actually heard; debit/credit is never model output;
  confirmation is a fixed grammar, valid for 60 seconds and tied to the draft's hash; amounts above
  the voice limit (default ₹1,00,000) or back-dated over 7 days need Ctrl+A on screen.

## Voice languages

The voice panel is a chat: speak (tap the mic or hold Ctrl+Space) or type, and replies are read aloud
(▶ on any reply plays it again; 🔊 mutes). After a question it listens for your answer. Pick the
language at the top of the panel; the choice is remembered per browser.

The first time you use the microphone the panel explains where the audio goes (see [Privacy](#privacy))
and asks you to agree; until then the microphone is never turned on, and typing still works.

**Wake word (off by default).** Tick **Start by saying "Kannaku"** in the voice panel and agree to the
hands-free notice. Then say "Kannaku" and your question in one go ("Kannaku, ABC Corp evvalavu
baaki?"), or say "Kannaku", wait for the chime, and ask. A green dot on the Voice button shows it is
listening; untick the box to turn it off. The word only counts at the start of a sentence, so everyday
use of கணக்கு doesn't trigger it. Listening pauses while the tab is hidden. In a hands-free
conversation a bare "yes" or "sari" never posts (it may be someone else talking nearby): say
"Kannaku, confirm" / "Kannaku sari", or press Ctrl+A.

| Language | Speech recognition | Readback | Notes |
| --- | --- | --- | --- |
| English / Hinglish | en-IN | English | Hindi number words (pachpan sau, dedh lakh) are understood |
| தமிழ் Tamil | ta-IN | Tamil | Tamil-script and romanised number words (ஐயாயிரத்து ஐநூறு, anju aayiram); confirm with சரி, cancel with வேண்டாம் |
| Tanglish | ta-IN | Tanglish, spoken by the Indian English voice | Speak Tamil; replies come in Tamil written in English letters ("Endha customer-ku?"), so they are read aloud in any browser. Confirm with sari, cancel with vendam |

Tamil script in what you say switches replies to Tamil even when English is selected. Party and item
names stay in English in the books; Tamil speech is transliterated to find them, and the model matches
names by sound. Spoken Tamil replies need a Tamil voice in the browser: Microsoft Edge includes one;
without it, replies are shown as text. The Tamil message templates are in
`server/src/ai/voice/i18n.ts` (and a few in `web/src/components/Voice.tsx`) and should be reviewed by a
native speaker before customers use them.

## Privacy

What leaves this computer, and to whom:

| What | Goes to | When |
| --- | --- | --- |
| PDFs and photos you upload; Excel/CSV sheets the app cannot read by itself | Anthropic (Claude API) | AI is on |
| Bank statement lines no rule or earlier choice matches (date, amount, narration) | Anthropic | AI is on |
| What you say or type to the voice assistant | Anthropic | AI is on |
| Your company name and GSTIN, and ledger, party and item names, with each of the above | Anthropic | AI is on |
| Microphone audio | Google (Chrome) or Microsoft (Edge) speech recognition | You use the mic, or the wake word is on |

Recognised Excel/CSV statements, journals and registers are read on this computer. Kannaku AI never
receives or stores audio, only the text the browser produces; voice requests are kept in the company's
voice log. The app shows these notices where they apply: in the AI key dialog, on the Documents
screen and before the microphone is first used. Anthropic's
[commercial terms](https://www.anthropic.com/legal/commercial-terms) say it does not train its models on
API data by default; see its [privacy policy](https://www.anthropic.com/legal/privacy).

The documents you upload contain your customers' and suppliers' details (names, GSTINs, account
numbers). If you run Kannaku AI for a business, check that your own privacy notice to them, and India's
Digital Personal Data Protection Act, allow sending them to these services, and tell your staff before
they use voice.

Tally and TallyPrime are trademarks of Tally Solutions Pvt. Ltd. Kannaku AI is not affiliated with or
endorsed by Tally Solutions; it follows familiar Indian accounting conventions (the 28 standard groups,
voucher keys) so it is easy to pick up.

## Not built yet

Compared with the spec, this build leaves out:

- **GST filing:** GSTR-1/3B JSON export, GSTR-2B reconciliation, e-invoice / e-way bill (Phase 4).
- **Roles and invitations:** each company has one owner; inviting accountants, the desktop app, TDS/TCS (Phase 4).
- **Opening stock entry for items:** record stock through purchases for now.
- **Old Excel (.xls) and password-protected PDFs** are not read; re-save as .xlsx or remove the password.
- **Bill reading:** no e-invoice QR decoding and no image pre-processing (deskew, crop); embeddings
  are not used in matching (trigram similarity only).
- **Voice:** uses the browser's speech recognition and speech synthesis rather than a server STT, and
  journal entries by voice are redirected to the screen.
- **Single process:** PGlite runs inside the server; for a multi-user deployment, point the same SQL
  at a PostgreSQL server and replace the in-process job queue with pg-boss.
