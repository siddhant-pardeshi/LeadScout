<div align="center">

<img src="assets/banner.svg" alt="LeadScout — paste companies, get decision-makers as CSV" width="100%">

# LeadScout

Paste a list of companies. Get the decision-makers back as one clean CSV —
names, roles, emails, LinkedIn profiles. Chrome and Edge, everything runs in your browser.

[![License](https://img.shields.io/badge/license-MIT-34D399)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Edge](https://img.shields.io/badge/Edge-supported-0078D7?logo=microsoftedge&logoColor=white)](https://www.microsoft.com/edge)

[Install](#install) · [The CSV](#the-output) · [Keys](#keys-all-optional) · [How it stays accurate](#accuracy-rules-enforced-in-code)

</div>

<div align="center">
<img src="assets/divider.svg" width="100%">
</div>

<div align="center">
<img src="assets/pipeline.svg" alt="Your list → Bing → company pages → optional AI → CSV" width="100%">
</div>

## What it does

You have companies. You need the people who can say yes to AI, software, automation or digital-transformation work.

- Paste 50–100 companies — LinkedIn URLs, plain names, or mixed lines. Duplicates removed.
- Each company is researched on its own: its own Bing searches, its LinkedIn about-page, an optional AI pass. Company A's CEO can never end up under Company B.
- You download one CSV with exactly ten columns. Nothing else comes out.

## The output

```csv
PROSPECT_FIRST_NAME,PROSPECT_LAST_NAME,DESIGNATION,EMAIL_ID,COMPANY_NAME,COMPANY_SIZE,COUNTRY,INDUSTRY_TYPE,WEBSITE_NAME,LINKEDIN_URL
```

- Names are split into first and last for you.
- `EMAIL_ID` is filled when it can be sourced — verified through Hunter.io, or a pattern estimate marked `estimated — unverified`. Otherwise it stays blank.
- `WEBSITE_NAME` is the company's real domain, only when a source-backed site was found.
- `LINKEDIN_URL` only ever contains a real person profile (`/in/`, `/pub/`) that showed up in search. Never guessed. Never a company page. Tracking params stripped.
- "Former CEO at Acme" never comes back as a current role. People flagged as possibly-past are left out of the table and of the file.
- Blank means blank. No filler rows.

<div align="center">
<img src="assets/columns.svg" alt="The ten CSV columns" width="100%">
</div>

## Workspace (side panel)

Research a list of companies, or work the page you are already on. Both end in the same ten columns.

Press the **▤** button in the popup header, or right-click any page and choose **Extract prospect to LeadScout**. The workspace opens as a Chrome/Edge side panel, so it stays visible while you browse.

| Action | What it reads |
|---|---|
| **⌖ Extract current page** | A LinkedIn profile (`/in/`), a LinkedIn people-search or list page, or a company team/about page — including JSON-LD `Person`/`Organization`, team cards, `mailto:` links and `linkedin.com/in/` anchors |
| **Right-click → Extract prospect** | Your text selection ("Asha Shah — CTO at Acme Corp", or name / role / company on separate lines), plus the page it came from |
| **＋ Row** | An empty row you type into |
| **↯ Resolve missing** | Fills only blank `LINKEDIN_URL` cells, one paced lookup at a time |

The table itself:

- Sticky header with the exact ten columns, every cell editable in place.
- A **link icon** on `WEBSITE_NAME` and `LINKEDIN_URL`; both open in a new tab.
- Dedupe by profile URL first, then email + name. Re-extracting the same page fills blanks instead of adding duplicates.
- Rows persist in `chrome.storage.local`, so a browser restart does not lose your table.
- **⤓ CSV** downloads the ten-column CSV with a UTF-8 BOM, the same file the popup gives you.

### How a missing LinkedIn URL is resolved

1. **Direct** — the extractor already found a `/in/` or `/pub/` anchor next to that person. Shown as **Verified Direct**.
2. **Search** — a paced Bing lookup for `site:linkedin.com/in/ "First Last" "Company"` (designation if company is blank). A result is accepted only when its own title or snippet contains every name token. Shown as **Auto-Resolved**.
3. **Fallback** — nothing credible found: the cell stays empty, a **Needs Review** / **Verify** badge links to a search you can check yourself, and you can paste the URL by hand.

Lookups are serialized and spaced ~1.9 s apart. If Bing raises a captcha or consent screen the resolver stops and tells you, instead of hammering the page. No profile URL is ever constructed from a name.

## One export, one table

| Button | What you get |
|---|---|
| **⬇ Download CSV** | A file with exactly the ten columns, in this order. It opens straight in Excel; names like José García read correctly. |
| **📋 Copy CSV** | The same text on the clipboard, ready to paste into Excel or a CRM importer. |

There is no other format and no optional extra columns. The table on screen is the file: each cell shows the value the CSV holds, and an empty cell on screen is an empty cell in the file.

A value that contains a comma, a quote or a line break is quoted, so `Managing Director & CEO, Godrej Consumer Products` stays in **DESIGNATION** and never shifts the row.

## Troubleshoot

If a column looks empty, a button does nothing, or a download does not arrive: press **🩺 Troubleshoot**. It is in the popup's top bar, under the results, on the full results page and in the workspace.

It checks the extension and the export itself, then tells you what is wrong and why:

- whether the background part of the extension is running, and whether it is the same version as the page
- whether every button on the page is connected
- whether the export would contain rows right now — it builds the CSV and reads it back to confirm ten columns
- how full each column is, and the real reason a column is sparse (for example: the LinkedIn lookup covers at most 6 people per company per run, or no Hunter.io key is saved, or Bing stopped the lookup with a human check)
- whether a filter is narrowing what gets exported, and who was left out as a possibly-past role

Where a fix is a single action, the finding has a button for it — reload the extension, show all rows again, resume research, retry failed companies, refresh the data, switch the profile lookup on. **Copy report** puts the whole diagnosis on the clipboard, so you can paste it into an issue or a message.

When an export would produce no rows, LeadScout does not save an empty file. It opens Troubleshoot on the reason instead.

## Install

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder. (Edge: same folder via `edge://extensions`.)
2. Pin LeadScout. Stay logged into LinkedIn in that browser.
3. Paste companies → **Start research** (or Ctrl+Enter) → **Download CSV**. For page-by-page work, open the **▤** workspace and press **Extract current page**.

Quick mode ≈10 s per company, Standard ≈15–25 s, Deep ≈25–40 s. The queue runs in the background — close the popup and keep working. Pause / Resume / Stop / Retry / Refresh-all are all there, and if Bing asks for a human check, the queue pauses itself and resumes when you're done.

## Keys (all optional)

Works with zero keys — public Bing results only. To fill more fields:

| Key | Free at | Adds |
|---|---|---|
| Groq | [console.groq.com](https://console.groq.com) | faster result structuring |
| Gemini | [aistudio.google.com](https://aistudio.google.com) | web-grounded recovery for thin companies |
| OpenRouter | [openrouter.ai](https://openrouter.ai) | free Llama models |
| Hunter.io | [hunter.io](https://hunter.io) | verified emails (~25 domain searches/mo free) |
| Custom | your endpoint | any OpenAI-compatible API |

Settings → **API keys** saves each key into this browser only, with an optional expiry date so you remember to rotate it. There's a Test key button next to every field.

## Accuracy rules (enforced in code)

- A profile URL is kept only if it came from a real search result for that company — or from the company's own leadership page, with the source linked in the UI.
- The AI can only propose people whose names already appear in that company's own results; roles are re-read from the evidence, not taken from the model.
- If a company's own website lists its leadership, those rows are marked **Official** in the UI with the page linked.
- Someone flagged as possibly no longer in that role is left out of the table and of the CSV. Troubleshoot says how many were left out.

## Notes

- No server, no analytics, no account. Keys stay in this browser profile and are sent only to their own provider.
- LeadScout reads public search results and public pages at a human pace. Keep volumes reasonable and follow your local privacy law for outreach data.
- Some company sites block automated reads; those rows come back marked "source blocked" rather than guessed.

## Changelog

| Version | What changed |
|---|---|
| **2.5.4** | `COUNTRY` fills from the company's own search snippets when no page states an address — the same country must appear in at least two results that name the company, so a passing "expands to the US" cannot relabel it. Welspun now exports `India · Textiles · 50,000+ employees · welspun.com` with only `LINKEDIN_URL` blank. |
| **2.5.3** | **Regression fix.** Per-person profile lookup now defaults to **off**, like the earlier builds. It used to run up to six extra Bing searches inside every company, which consumed the queue's search budget, triggered Bing's consent wall and left runs with no rows. Research is back to: rows with every fact it can source, and a blank LINKEDIN_URL when nothing was found. Turn lookup on in Settings when you want it. |
| **2.5.2** | Optional **Fill empty cells with "Not Found"** (Settings, off by default) so a downloaded CSV shows every column populated; real values are never replaced and the default stays blank for clean CRM imports. Contact pages are now crawled for the registered address, and "Address:"/"Regd. office" phrases count as HQ evidence — that is where COUNTRY comes from. |
| **2.5.1** | A company with no accepted person is now a **notice row** across the full width ("NO PROSPECT — JioMart — reason"), instead of that reason being painted into DESIGNATION, where it read like a person with a 12-line job title and put text in a column the CSV keeps empty. Leadership discovery also tries eight more about/board paths. |
| **2.5.0** | The export is the ten-column CSV and nothing else: the 19-column "Full CSV" and every "Copy TSV" button are gone from the popup, the results page and the workspace. The workspace table is ten columns wide again (a row is deleted from inside its last cell). Column names are never shortened or clipped, the LinkedIn cell shows the address itself, and the table lists exactly the people the CSV writes. Row order now really follows priority (the comparison silently fell back to score before). New **🩺 Troubleshoot** panel explains an empty column, a dead button or a missing download and offers the fix. A real-browser test (`tools/e2e.ps1`) presses the actual buttons and reads the file. |
| **2.4.2** | An export that would contain zero rows is refused with the counts that explain it ("1 companies, 1 people, 0 exportable rows — past-role or under review") instead of silently saving a header-only file. The results page gains **ⓘ Diagnostics**: one JSON with version, queue state and, per company, people vs exportable rows. |
| **2.4.1** | A blank screen can no longer happen silently: uncaught errors and rejected promises raise a readable banner, every button binds defensively (a missing element is skipped, not fatal), and an export with zero exportable rows is refused with a reason instead of saving a header-only file. |
| **2.4.0** | Export pass: a **Full CSV (19 columns)** carries email status, LinkedIn source, HQ, company LinkedIn URL, role currency, priority, verification, evidence URL and source; **Copy TSV** pastes into columns when Excel ignores the comma delimiter; the company-link field stopped being validated as a person URL (it was always blank); RFC-4180 round-trip, quoting and no-column-shift are now regression-tested. |
| **2.3.1** | Bug sweep: a page-wide email no longer attaches to every JSON-LD person; `in.linkedin.com` and `www.linkedin.com` are one identity (no duplicate rows, canonical CSV); the resolver circuit breaker clears on Resume; a consent/captcha during resolution now raises a visible notice instead of silently blanking; the panel works at 380px with an internal table scroll; empty rows no longer show a Verify link; “Asha at Acme” is rejected as a name. |
| **2.3.0** | Profile resolution actually returns URLs now. Two bugs fixed: the Bing query `site:linkedin.com/in/ "Name" "Company"` returns **zero** results (a second quoted phrase collapses the set) so the name-only query runs first with the company as a narrower retry; and `chrome.tabs.update` resolves before navigation starts, so the extractor was reading the previous page — navigation now waits for the tab to leave the old document. Research rows also get a bounded resolution pass (6 per company, stops if Bing asks for consent/captcha), and a blank cell now explains itself on hover. |
| **2.2.1** | Official leadership rows now keep the LinkedIn profile link published on the company page. That URL used to be discarded, which is why the CSV column came back empty. The link is never marked verified, and a company-page link is still rejected. |
| **2.2.0** | Side-panel workspace: extract the current LinkedIn profile, people list or company team page; capture a selection from the context menu; edit all ten columns in place; paced LinkedIn URL resolver with Verified Direct / Auto-Resolved / Needs Review; CSV and TSV from one row model. |
| **2.1.1** | Results tables mirror the CSV contract exactly; leaner README and artwork. |
| **2.1.0** | Single 10-column CSV export across popup and results. |

## Development

```bash
node tools/test.mjs              # 119 checks: parsing, ranking, the CSV contract, the troubleshoot logic
node tools/diag_linkcheck.mjs    # standalone module-link check
powershell -ExecutionPolicy Bypass -File tools\e2e.ps1   # real-browser test
```

The real-browser test starts a throwaway Microsoft Edge profile with this folder loaded as an extension, feeds it a known research result, presses the real **Download CSV** and **Copy CSV** buttons on every page, and reads back what came out. It checks that the header is exactly the ten columns, that every row has ten fields, that the table on screen reads like the file, and that Troubleshoot finds and fixes what it should. It takes about 20 seconds and leaves your own browser profile untouched.

It needs Microsoft Edge or a Chromium build. Google Chrome no longer loads an unpacked extension from the command line.

```
manifest.json        MV3 config
background.js        queue engine, Bing/LinkedIn/company-page readers, pipeline
popup.html/.css/.js  main UI, key vault, progress, exports
sidepanel.html/.css/.js  wide workspace: capture, edit, resolve, export
content.js           on-page extractor (profile / list / team / selection)
results.html/.js     full-page results view
lib/                 parse · records · rank · ai · hunter · extract · keys · platform · verify-lead
                     diagnose (troubleshoot logic) · troubleshoot (its panel) · ui-guard
assets/              animated SVG previews
tools/               unit tests, real-browser test, icon generator
```

<div align="center">
<img src="assets/divider.svg" width="100%">
</div>

<div align="center">
<img src="assets/star-cta.svg" alt="Star the repo if LeadScout saved you time" width="100%">
</div>

<div align="center">
<img src="assets/footer-cta.svg" alt="Install in two minutes: load unpacked, pin, export CSV" width="100%">
</div>

<div align="center">

Built by [siddhant-pardeshi](https://github.com/siddhant-pardeshi) · MIT — see [LICENSE](LICENSE)

</div>
