# Lead evidence evaluation

Use Node 22 or later. The runner includes 11 labeled role claims across 10
product companies, using short saved public excerpts and a fixed evaluation
date of November 23, 2026.

```sh
node tools/eval-evidence.mjs
node tools/live-eval-evidence.mjs --offline
node tools/live-eval-evidence.mjs groq
```

For a live run, provide `GROQ_API_KEY`, `GEMINI_API_KEY`, or
`OPENROUTER_API_KEY` through your environment and choose the corresponding
provider argument. The runner sends the public fixture excerpts to that
provider. It exits nonzero if requests fail and reports provider failures
separately from unverified claims.

| Offline comparison | Current labels correct | Current roles recovered | Confirmed current sent to review |
| --- | --- | --- | --- |
| Existing role classifier | 8/11 | 8/8 | 0/8 |
| Evidence verifier with hand-authored citations | 5/5 | 5/8 | 3/8 |

The baseline passes each saved excerpt to the existing role classifier as a
title. This isolates the role-labeling heuristic. The fixture suite does not
measure search recall, candidate selection, or LinkedIn profile verification.
The offline verifier uses hand-authored citations and does not measure model
extraction. No live provider run was performed for the results above.

The offline verifier abstains on three valid attribution formats and returns
unverified on a former role expressed as a dated departure. The set is a
small, executive-heavy pilot for evaluating role evidence.
