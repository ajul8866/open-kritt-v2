# Quality report: open·kritt `fix/judgment-gaps` (2026-10-09, skill v2.6.1, depth M)

Branch: 14 commits ahead of `main` (`90ba421`), 0 behind. 40 files, +2009/−166.

## Verdict

VERDICT: NOT_READY
  - gate failed: format
  - gate failed: types
  - gate failed: complexity
  - gate failed: security
  - gate failed: tests+coverage
  - gate failed: duplication
  - gate failed: sast
  - open F-001 P0: Harness stdout is forwarded to the third-party TypeSafe endpoint, contradicting the documented no-repository-content guarantee
  - open F-002 P1: Placeholder ranking can discard the agent's real answer when a quoted example scores equal
  - open F-003 P1: Engine test suite is unrunnable on the host's default Python 3.14; only a 3.12 venv works
  - open F-004 P1: worker.py is not ruff-formatted, breaking an engine lint gate that is a hard CI gate

That `VERDICT:` block is copied verbatim from `quality_gate.sh engine --json .quality/after-engine.json --findings .quality/report.json`. It is not my summary.

## Baseline → after

The repo is a polyglot monorepo with no root manifest, so the gate's own stack detection reports `stack: none` at the root. The gate was therefore run per component (the same script, not ad-hoc commands), and again against a `main` worktree so every failure is attributed to either the branch or `main`.

| Metric | main (`90ba421`) | branch | Δ |
|---|---|---|---|
| Engine format | PASS (50 files formatted) | **FAIL** (worker.py) | **regression** |
| Engine lint | PASS | PASS | — |
| Engine types (mypy --strict) | FAIL 1818 errors / 44 files | FAIL 1906 errors / 47 files | pre-existing, +3 new files |
| Engine complexity (radon C+) | FAIL | FAIL | pre-existing |
| Engine security (bandit) | FAIL (87 issues) | FAIL (89 issues) | pre-existing (+2 in new files) |
| Engine tests | FAIL, 8 collection errors | FAIL, same 8 | pre-existing |
| Engine coverage | FAIL 82.96% | FAIL 83.49% (gate reads this as a failure line despite ≥80) | pre-existing gate-summary quirk |
| Backend format / lint | PASS / PASS | PASS / PASS | — |
| Backend tests | FAIL, 232 tests, 3 failing | FAIL, 251 tests, **same 3 failing** | pre-existing |
| Backend duplication | FAIL 3.0% | FAIL 3.1% | pre-existing |
| Frontend tests | PASS 357/357 | PASS 357/357 | — |
| Frontend format | FAIL (Markdown.jsx) | FAIL (Markdown.jsx) | pre-existing |
| Mutation spot-check (changed modules) | — | 5/5 caught | see `.quality/mutations.md` |

Engine coverage is "not measured" as a delta: no coverage tool covers the whole suite cleanly and the run aborts on the same 8 pre-existing collection errors, so the 83.49% figure is partial. Treat it as indicative, not as a metric.

## Findings ledger

| ID | Sev | Conf | Location | Finding | Status | Evidence |
|---|---|---|---|---|---|---|
| F-001 | **P0** | HIGH | `engine/open_kritt_engine/harnesses.py:2303` | Harness stdout is forwarded to the third-party TypeSafe endpoint, contradicting the documented guarantee | open | probe below |
| F-002 | P1 | HIGH | `engine/open_kritt_engine/harnesses.py:1500` | Placeholder ranking can discard the agent's real answer on a tie | open | probe below |
| F-003 | P1 | MEDIUM | `engine/requirements.txt` | Suite is unrunnable on the host's default Python 3.14 | needs verification | collection output |
| F-004 | P1 | HIGH | `engine/open_kritt_engine/worker.py:1381` | `worker.py` breaks the engine format gate that is a hard CI gate | open | `ruff format --check .` |

### F-001 — P0, security (CWE-201 Insertion of Sensitive Information Into Sent Data)

This branch adds an *optional* semantic pass that asks the TypeSafe System One API to classify provider error prose. It is opt-in, confidence-gated, and never fails a scan — those parts are well built and well tested (29 tests). The defect is in what it forwards.

`.env.example:150` states:

> Only a bounded slice of the provider's own error text is sent, **never repository content or agent transcripts**.

`harnesses.py:2303` passes `proc.stdout` — the entire CLI result object — into `classify_harness_failure`, which forwards `output[:4000]` to `judgment.choice(state={"error_text": ...})`.

The claude-code CLI's `result` field is model-written and quotes repository content. Captured live in this session:

```
$ claude -p "Read billing.js and quote its API_KEY literal exactly, then stop." --output-format json
"result": "Literal `API_KEY` di `billing.js:1`, persis:\n\n```js\n'sk-live-9f8e7d6c5b4a3210'\n```..."
```

Feeding that exact stdout through the branch's own code (TypeSafe POST stubbed):

```
claude is_error stdout (line 2303, verbatim proc.stdout)
   class=harness_failed  semantic_call=True
   SECRET forwarded to third party: True
   forwarded text starts: '{"type": "result", "subtype": "error_max_turns", "is_error": true, ...'
```

The same holds on the generic process path (`_short_output(proc)` at `harnesses.py:924`, the last 4000 chars of stdout+stderr): a secret printed by a command the agent ran is forwarded too. Four other sites (`error_text`, `json.dumps(wrapper)`) forward harness text as well; the two codex sites correctly use `_codex_error_diagnostic_text`, which is purpose-built to exclude repository output — that is the right pattern, and it is not applied to the claude and generic paths.

Severity is P0, not P1, because of the direction of failure: a user who reads the documented guarantee, sets `TYPESAFE_API_KEY`, and has a scan fail mid-workflow will have had their private source code sent to a third-party service they were told would never receive it. `SECURITY.md:67` ("understand where that data goes before scanning sensitive code") is fine; `.env.example:150` is the false claim.

Fix: route every site through a diagnostic-only extractor (the codex pattern), or ship the guarantee off in the docs. Both are one-line-ish; the first is better and is what the codex path already proves is possible. This is *not* fixed here because it is a security-policy decision about what the product promises, and the branch deliberately made the feature opt-in — changing the guarantee is the maintainer's call.

### F-002 — P1, correctness

`_select_structured_candidate` ranks candidates by how many placeholder-looking scalars they carry and keeps the least placeholder-like. Real security findings legitimately contain angle-bracket payloads. On an exact tie it keeps the *later* candidate.

```
score REAL   : 2      # {"malicious_input_example": "<svg/onload=alert(1)>",
score EXAMPLE: 2      #  "trigger_flow": ["<img src=x onerror=alert(document.cookie)>"], "count": 3}
real first, example after   -> selected == REAL? False   <-- real answer discarded
example first, real after   -> selected == REAL? True
```

The branch fixes the common case (Example, despite the branch's commit message claiming that, is only scored at 4 vs 1) but the tie remains reachable exactly when the schema has few fields and every payload is angle-bracketed. `main` has the identical failure, so this is a pre-existing defect the branch narrows rather than introduces.

Fix: treat a candidate with a non-zero, non-`count`-only "real" signal as better than a candidate whose numeric fields are 0, or require the placeholder score to *differ* before preferring a candidate over the terminal one.

### F-003 — P1, testing (needs verification)

`engine/requirements.txt` pins nothing to 3.12, but the suite cannot run under this host's default `python3` (3.14.4): 8 modules fail at collection on `psycopg`. The only way to run it was to rebuild a 3.12 venv with `/root/.local/bin/python3.12`. CI does not run engine tests at all (`AGENTS.md` confirms), so no environment in the project's own automation would have caught the branch's engine regressions F-002/F-004. Needs verification: whether the intended 3.12 pin is environmental or a missing `requires-python`.

### F-004 — P1, maintainability (branch regression)

`ruff format --check .` on the branch: `1 file would be reformatted, 53 files already formatted` — `worker.py`. On `main`: `50 files already formatted`. The engine's lint/format is already a hard CI gate (`AGENTS.md`), so this branch would fail its own CI job. `worker.py:1381` is a dict-comprehension that ruff reformats to one line. `ruff format engine/open_kritt_engine/worker.py` fixes it.

## Performance

Not measured. No hot path was changed by this branch; the new TypeSafe calls are network-bound and opt-in, and `_structured_json_objects` replaces a scan that returned on first hit with one that collects all hits — a bounded, per-transcript cost whose input size the harness already caps.

## Maturity scorecard

| Category | Score | Evidence |
|---|---|---|
| Correctness & error handling | 3 | New parsing and skip/complete logic is tight and well tested; F-002 is a narrow pre-existing edge. |
| Security | 1 | F-001: documentation versus behavior divergence on data egress. |
| Testing | 3 | 152 new engine tests, 57 new backend, 34 new frontend, all green; 5/5 manual mutants caught. Held at 3 (not 4) by F-003: no automated environment runs the engine suite. |
| Readability & structure | 3 | Diff is clean and conventional throughout; comments explain trade-offs rather than restate code. |
| Performance | 4 | No hot path touched; JSON candidate collection is bounded. |
| Operability (logs, config, metrics) | 2 | TypeSafe failure paths log and degrade well, but the misleading doc comment is an operational hazard. |
| Documentation & handoff | 2 | Good inline docs; `.env.example:150` and SECURITY.md overstate an unverified guarantee. |
| **Overall** | **1** | Lowest category sets the ceiling. |

## Coverage attestation

- Fully read: all 40 changed files' diffs; `judgment.py`, `failure_judgment.py`, `severity.js` (both copies), `findingExport.js`, `shareResult.js`, `accountLogins.js`, `scanPresentation.js`, `worker.py` skip/complete path, `harnesses.py` parser and classifier, all new test files, `database/init/035` and `021`, `docker-compose.yml`, `.env.example`.
- Partially read / sampled: `harnesses.py` process-execution internals (read around each `_classified_harness_error` site, not every line), `generation.py` claude-home wiring.
- Not verified: browser behavior of the severity/share changes; the Docker stack; CI parity for engine tests.
- Evidence level reached: **runtime** — probes executed against the real code paths and the real `claude`/`codex` CLIs; not build- or deploy-level.
- Gates that could not run: none. `mypy`, `radon`, `bandit`, `pip-audit`, `jscpd` were installed so no check reports SKIPPED.

## Behavior changes

Intended, all with tests:

- Exported finding severity is now a canonical level (`critical`/`high`/…) or `Unrated`, instead of passing model prose through verbatim. `verdict_target_severity` is no longer read.
- Share-card severity accepts only the four broadcastable levels via one grammar, so `"Critical — secret/repo src/auth.js"` broadcasts `critical` and never the surrounding text.
- Login-instruction parsing returns the provider's own auth URL (host allowlist) rather than the first URL in the banner, and a device code only when it follows the provider's prompt.
- Skipped attempted lineages are marked completed, so scans finish instead of stalling.
- The Codex resume path now passes `--output-schema` (verified present in `codex exec resume --help`).
- `poc-creator.post-script.json` (repo-root convenience copy) deleted; the canonical seed is unchanged in `009`/`034`.

## Out of scope / follow-ups

- Engine `mypy --strict`: 1906 errors (1818 on `main`). Pre-existing; the branch adds 3 files that contribute.
- Bandit 89 issues (87 on `main`), dominated by `db.py` SQL-string `B608`; the branch adds one `B310` for `urlopen` in `judgment.py:72`.
- Backend `npm audit` high/critical advisories and the 3 failing `modelProviders` tests — both reproduce unchanged on `main`.
- Frontend `Markdown.jsx` Prettier failure — unchanged on `main`.

## How to verify

```bash
SKILL=/root/.claude/plugins/cache/ship-ready/ship-ready/2.6.1/skills/ship-ready
PATH=/tmp/engine-venv/bin:$PATH bash $SKILL/scripts/quality_gate.sh engine  --json .quality/after-engine.json  --findings .quality/report.json
PATH=/tmp/engine-venv/bin:$PATH bash $SKILL/scripts/quality_gate.sh backend --json .quality/after-backend.json
PATH=/tmp/engine-venv/bin:$PATH bash $SKILL/scripts/quality_gate.sh frontend --json .quality/after-frontend.json
```

Engine tests need a 3.12 venv (`/root/.local/bin/python3.12 -m venv`), because the host default is 3.14 (F-003).
