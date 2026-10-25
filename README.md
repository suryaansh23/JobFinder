# JobFinder

For Suryansh’s Windows automation and the consolidated updater, see [AUTOPILOT setup](docs/AUTOPILOT.md).

A local-first job-application assistant. It scans 19 job boards, scores each posting
against your CV, fills in application forms from an answer bank you approve, and builds
evidence-based interview prep from the job descriptions you actually saved.

Everything runs on your own machine. Your CV, answers, cookies and database never leave
it — there is no server component and no account.

```
Scan 19 sources  →  Score fit  →  Apply + autofill  →  Track pipeline  →  Interview prep
```

## Why it exists

Applying to jobs is mostly repetition: the same twenty answers typed into forms that all
ask slightly different questions, on sites that increasingly resist automation. JobFinder
does the repetition, learns from what you type, and stays out of the way when a site asks
you to prove you're human.

## What it does

**Finding work**
- **Signed-in sources.** Beyond keyword search, a signed-in session unlocks the feeds
  that actually carry applyable work: Naukri's profile recommendations and LinkedIn's
  Easy Apply collection, searched worldwide as well as locally so good jobs abroad are
  not filtered out by a location you happened to type. On one profile these took the
  applyable pool from 8 jobs to 103
- 21 connectors: Arbeitnow, Bluesky, Hacker News, Himalayas, Jobicy, Jobspresso,
  LinkedIn, LinkedIn Posts, Naukri, NoDesk, Otta, Psychology, Reddit, RemoteOK,
  Remotive, TechStartups, The Muse, Wellfound, We Work Remotely, Working Nomads,
  Y Combinator
- **Paste any link** — a posting from a site JobFinder doesn't scan becomes a normal
  job: opened in your browser, read via schema.org JobPosting data (LLM fallback when
  a page has none), then filled like any other
- **Fit scoring** — ranks every posting against your CV, skills and locations.
  Deterministic and instant; no LLM
- **Fresh this week** — everything posted in the last N days across all sources, newest
  first, with an honest distinction between "the source published this date" and
  "this is when we first saw it"
- Cross-board de-duplication: the same role scraped from four sites collapses to one
- **Hiring-contact directory** — addresses that ads publish themselves ("send your CV
  to …") are captured during scanning into an editable, CSV-exportable directory with
  company and, where stated, name and designation

**Applying automatically**
- **Auto-apply** completes LinkedIn *Easy Apply* and Naukri *on-site* applications
  without you — the two flows that finish on the job board rather than redirecting to
  an employer's ATS
- It **never invents a fact about you.** A drafted paragraph is a writing task and the
  model does it; "how many years of Kubernetes do you have" is not. Anything the answer
  bank cannot answer becomes a question, the application stops, and one answer unblocks
  every job waiting on the same question
- **Dry run by default** — fills every field, screenshots the completed form, and stops
  before Submit. Sending for real is a checkbox that is never remembered between runs
- **Deliberate batch mix** — half the batch local, a third worldwide, a fifth remote,
  with unfilled places going to remote first, then local, then worldwide
- **Naukri early access** — the roles recruiters are searching for *before* they post
  them. There is no application form; the action is "Share Interest", and auto-apply
  treats it with the same care as a submission
- **Scheduled runs** — repeat a batch every 20 minutes to 8 hours. Guarded by a daily
  cap derived from applications actually sent, so no restart or second window can reset
  it, and by a one-run-at-a-time lock
- **Salary expectations convert themselves.** One figure in your own currency becomes
  the right figure for the employer's country — at equal *purchasing power*, not at the
  exchange rate, because a straight conversion underprices you several times over. Both
  numbers are logged, and a figure you set for a market always wins
- **Notice period is computed, not stored.** Give it your last working day and every
  "notice period" answer is worked out from the date — right today and right in six
  weeks. Dropdowns get the bucket the real figure falls into, always rounding *up*
- **Applyable jobs are identified while scanning.** Naukri's own recommendation feed
  ("jobs based on your profile / your applies") reports which postings apply on Naukri
  and which redirect to the employer; LinkedIn's Easy Apply collection is walked
  separately. So a batch of 10 means 10 real attempts, not 10 postings that turn out to
  be someone else's application form
- Capped per run, with human pacing between applications, because both sites treat a
  burst of applications as automation

**Applying**
- **Answer bank** — captures what you type into application forms and replays it. New
  captures land in a **review queue** and are invisible to autofill until you approve them
- **Autofill** with three modes: bank-only, bank-then-LLM, or LLM-for-everything
- **In-page toolbar** — a floating widget with hotkeys on the application itself, so you
  never have to go back to the dashboard mid-form
- **CV variants** — keep several CVs, and the best match for each posting is scored and
  attached automatically
- **Cover letters** — a base template with placeholders, plus per-job letters written
  from that posting's description and your best-matching CV

**After applying**
- Pipeline tracker with stages, follow-up reminders and a funnel view
- **Mailbox (optional)** — recruiter replies are pulled in, matched to the job they're
  about, and the specific things HR asks you for are listed separately so none gets
  buried in a paragraph. One click moves the job to the stage the mail implies.
  Connect with an app password (2 minutes, works with Gmail/Outlook/Yahoo/iCloud) or
  Google OAuth. Paste-in still works and stores nothing
- **Interview prep** — reads your saved job descriptions, extracts the skills actually
  demanded, researches each one, and writes study notes with mental models, trade-offs,
  real numbers, level-by-level answers and cited sources
- Ask-anything Q&A over the prep knowledge base

## Privacy

This is the design constraint, not a footnote.

- **Local only.** SQLite on disk, Ollama on localhost. No telemetry, no cloud calls except
  to the job boards themselves and the sources prep cites
- **`data/` is gitignored in full** — database, résumés, cover letters, browser profiles,
  cookies. Nothing personal is in this repository, and nothing you add will be
- **Mail access is narrow.** Every sync runs a search built from your own applied
  companies — unrelated mail is never requested, downloaded or stored. OAuth uses the
  read-only `gmail.readonly` scope; an app password grants full mailbox access but
  JobFinder only ever reads. Credentials live in `data/gmail.json` / `data/mail.json`,
  mode 0600, gitignored, and are revocable from your Google account page
- **The contact directory only reads text already fetched** for a posting. Nothing is
  crawled to find addresses, and none is ever guessed from a name-and-domain pattern.
  Job-seeker posts and staffing-vendor pitches are filtered out
- **Sensitive fields are never captured.** Passwords, CVV, SSN, OTP and similar are
  excluded at the point of capture, before anything is stored
- **Honeypots and CAPTCHAs are never filled.** Completing an invisible field is a
  self-inflicted bot verdict

## Requirements

- **Node.js 20+**
- **Google Chrome** (real Chrome, not just the bundled Chromium)
- **[Ollama](https://ollama.com)** for the local LLM — optional, but autofill drafting,
  cover letters and interview prep need it

## Giving it to someone else

`npm run build:desktop` produces a standalone application — a real window, with Chromium and
the Node runtime inside it, that installs the local model runtime on first launch. The
recipient double-clicks it; there is no terminal, no `npm install`, and no localhost URL.
See **[desktop/README.md](desktop/README.md)**, including an honest account of what the
build does and does not do to protect the source.

## Quick start

```bash
git clone https://github.com/abk149/JobFinder.git
cd JobFinder
npm install
ollama pull qwen2.5:7b-instruct
ollama pull all-minilm
npm run build
npm start
```

Open <http://localhost:3737>.

Full instructions, including model choice and the browser-session model, are in
**[SETUP.md](SETUP.md)**. How to actually use it day to day is in
**[USER_MANUAL.md](USER_MANUAL.md)**.

## How it works

**Lazy attach.** Chrome runs with a debugging port but *no* automation client connected.
When you press Autofill, JobFinder attaches for a couple of seconds, fills, and detaches.
The window you get verified in has nothing attached to it.

**Anti-detection.** Uses `rebrowser-playwright`, which avoids the `Runtime.enable` CDP
call that commercial bot-detectors fingerprint, plus an init script covering
`navigator.webdriver`, plugin identity, WebGL vendor and the `chrome.*` surface.
`scripts/test-stealth.mjs` asserts 23 fingerprint probes.

**Two kinds of knowledge.** Personal information — name, contact, links, where you live —
is a short fixed list you confirm once, kept apart from the answer bank and checked for
shape. Everything else is a reply to a question an employer asked. Mixing them is how a
form question that merely *mentioned* email ended up storing "Yes" as the email address.

**Retrieval.** Answers are matched by exact key first, then by cosine similarity over
`all-minilm` embeddings, and only then handed to the LLM — which is told to return
a literal `[BLANK]` rather than invent a phone number.

The embedding model was chosen by measurement, not reputation. `nomic-embed-text` — the
obvious default, and what this project shipped with — produces vectors dominated by a
single component that barely varies with the text, so cosine measures almost nothing: it
scored the unrelated pair *"Expected CTC"* / *"City: Berlin"* at **1.000** and got 1 of 8
answerable questions right. `all-minilm` gets 8 of 10 on the same bank, is 6x smaller, and
keeps every question the bank *cannot* answer below the verbatim-fill threshold, so those
fall through to the LLM instead of being confidently filled with the wrong value.

## Project layout

```
app/            Next.js App Router — UI (app/page.jsx) and API routes (app/api/*)
connectors/     One module per job board; each exports scan() and apply()
lib/            Core: browser control, autofill, answer bank, retrieval, cover letters
lib/prep/       Interview prep: skill extraction, research, synthesis, Q&A
scripts/        Launcher install, Windows packaging, stealth + data-hygiene checks
data/           Local state. Gitignored in full. Created on first run
windows/        Windows packaging: one-click installer, launcher, build + verify
```

## Useful commands

```bash
npm run dev                              # dev server on :3737
npm run build && npm start               # production
node scripts/test-stealth.mjs            # 23 anti-detection probes
node scripts/test-autofill.mjs           # autofill end-to-end against a real form
node scripts/test-observer-escaping.mjs  # guards the observer's template-literal escapes
node scripts/test-notice-period.mjs      # notice-period arithmetic and dropdown bucketing
node scripts/test-location-mix.mjs       # how a batch is composed by location
node scripts/test-identity.mjs           # personal info stays separate from answers
node scripts/repair-external-verdicts.mjs # undo "applies elsewhere" verdicts made during a limit
node scripts/split-knowledge-base.mjs    # label existing answers, repair bad personal fields
node scripts/test-salary-expectation.mjs # currency detection and salary conversion
node scripts/clean-answer-bank.mjs       # audit the answer bank (dry run)
node scripts/check-canon-parity.mjs      # field-key canonicaliser parity check
npm run install-launcher                 # desktop launcher (macOS)
npm run build:desktop                    # standalone app for macOS + Windows
npm run verify:desktop                   # 23 structural checks on those packages
npm run build:windows                    # windows/dist/JobFinder-Windows.zip
npm run verify:windows                   # 22 structural checks on that bundle
```

## Status and honest limitations

Built for one person's job search, then generalised. Expect rough edges.

- **Site markup changes break scrapers.** LinkedIn's content search now uses per-build
  hashed class names; that connector reads structure instead, and returns author profile
  links because post permalinks are no longer in the DOM
- **Naukri and LinkedIn Posts need a logged-in session.** Use *Open & log in* on those
  sources first; they fail fast with instructions rather than hanging
- **Local models are slow.** A full interview-prep refresh is roughly 40 minutes on an
  8B model. It runs one skill at a time and writes each note as it completes
- **Reasoning models are the wrong tool for structured output.** `deepseek-r1` spends its
  token budget inside `<think>` before emitting JSON. Use an instruct model for synthesis;
  the app auto-selects one if installed

## Licence

MIT — see [LICENSE](LICENSE).

Use it on your own applications. Respect each site's terms of service; you are
responsible for how you use it.
