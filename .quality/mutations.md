# Manual mutation spot-check (no mutation tool installed)

Each mutant was applied to the working tree, its covering test run, and the change
reverted — one command per mutant, output observed in this session. This is a
spot-check, not a mutation score.

| # | File | Mutation | Covering test | Result |
|---|------|----------|---------------|--------|
| 1 | `engine/open_kritt_engine/harnesses.py` | `best_score = min(...)` → `max(...)` (invert placeholder ranking) | `engine/tests/test_process_runtime.py` | caught — 4 failures |
| 2 | `engine/open_kritt_engine/failure_judgment.py` | `if not answer.trusted:` → `if False:` (remove confidence gate) | `engine/tests/test_failure_judgment.py` | caught — `test_low_confidence_keeps_the_deterministic_result` |
| 3 | `engine/open_kritt_engine/worker.py` | drop `completed \|= skipped` | `engine/tests/test_engine.py` | caught — 3 failures |
| 4 | `frontend/src/lib/severity.js` | `!SHAREABLE_LEVELS.includes(level)` → `level === 'nope'` (loosen share gate) | `frontend/src/lib/severity.test.js` + `shareResult.test.js` | caught — 3 failures |
| 5 | `backend/src/lib/accountLogins.js` | take the first URL instead of the host allowlist | `backend/test/accountLogins.test.js` | caught — 2 failures |

All five mutants were caught; no mutant survived. The egress defect (F-001) has no
covering test — that is why it is reported rather than fixed here.
