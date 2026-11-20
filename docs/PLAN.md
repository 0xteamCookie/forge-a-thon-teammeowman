# Round 1 plan: TrueForge Forge-a-thon

**Deadlines.** Registration closes **15 Nov**. Submission **20 Nov, 23:59 IST**; we submit by **18:00 on 20 Nov** because ties break on earlier submission time. Top 15 by score go to the finals (16-18 Dec, IIT Bombay).

**How we get shortlisted.** Two judges score 100 points against fixed written anchors; between two anchors, the lower one applies. So every criterion has to *visibly* hit its top anchor on screen and be claimed with a timestamp in the write-up. Nothing in between counts.

---

## 1. Scoring map (every row must reach the right-hand column)

| Criterion | Pts | Top anchor (what judges must see) | How Anvil hits it | Status |
|---|---|---|---|---|
| A1 Inline edit | 10 | Diff in editor, per-hunk accept/reject | Ctrl+Alt+I, streams into VS Code diff editor, Accept/Reject CodeLens on each hunk | Built, needs in-editor test |
| A2 Agent mode | 10 | Discovers and edits 3+ files unprompted (Task B) | Pre-retrieval ranks `cli.py`, `test_cli.py`, `docs/cli.rst` top 3 (tested); agent uses MCP tools | Retrieval tested; full run needs real model |
| A3 Streaming + cancel | 10 | Immediate cancel, workspace consistent | Tokens stream from TrueForge SSE; Esc/Stop calls `sessions.cancel`, kills commands, discards open reviews, rolls back the run's writes | Built, needs in-editor test |
| B1 Context assembly | 15 | Retrieval with a size budget, strategy in write-up, **visibly at work in Task B** (files chosen and why) | Context card in panel: each file, view (full/chunk/outline), tokens, and the reasons; budget meter; "left out" list | Built + tested on Flask |
| B2 Diff safety | 10 | Per-hunk review **and a working undo of an applied change, shown on screen** | Nothing written until every hunk is decided; one atomic write; Undo button + command | Built, needs in-editor test |
| B3 Resilience | 10 | Automatic fallback to a second model, no user action, workspace unchanged | Retry with backoff, then next model in `anvil.models`, fresh session | **Tested live** (mock 401 -> retry -> fallback) |
| B4 TrueForge depth | 10 | Editor tools as MCP, approval drives diff review, plus a context-engineering feature explained and visible in the session | `anvil-editor` MCP server; `require_approval_for_tools` -> review; deferred tool loading (`run_command`, `find_symbol`, `list_files` load on demand); subagents enabled; compaction | **Tested live** (approval pause -> resume -> MCP write) |
| C1 Video | 10 | A, B, C complete, legible, verified on screen | See [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | To record 18 Nov |
| C2 Write-up | 15 | Architecture, context strategy, model setup, trade-offs, **accurate scorecard with timestamps, honest limitations** | [WRITEUP.md](WRITEUP.md) draft exists; fill timestamps after recording | Draft |

**Eligibility gate (pass/fail, checked first):** loop runs on TrueForge (yes); extension is a TrueForge client via SDK (yes); editor capabilities exposed as MCP tools (yes); TrueForge in local mode via npx (yes); no direct provider calls (yes: the extension has no provider code at all); video shows the TrueForge session for Task B (to do in recording); agent definition in the repo (`extension/agents/*.json`).

---

## 2. What is built and verified today (12 Nov)

| Piece | Where | Verified how |
|---|---|---|
| Hunk model (subset application, CRLF, new files) | `extension/src/review/hunks.ts` | unit tests |
| Edit application (exact, whitespace-tolerant, never guesses) | `extension/src/review/edits.ts` | unit tests |
| Context engine (index, BM25, symbols, imports, analogues, budgeted packing) | `extension/src/context/` | unit + Flask regression: Task B top 3 = the 3 right files |
| MCP server (8 tools, annotations, bearer token, loopback) | `extension/src/mcp/server.ts` | live, through TrueForge |
| TrueForge service (agents, sessions, streaming, approvals, cancel, retry, fallback) | `extension/src/trueforge/service.ts` | live e2e with mock model |
| Review manager (diff editor, CodeLens, atomic write, undo, run rollback) | `extension/src/review/reviewManager.ts` | typechecked only |
| Inline edit, agent panel, activation | `extension/src/inline`, `panel`, `agent`, `extension.ts`, `webview/` | typechecked + bundled only |
| Flask 3.1.3 fixture | `../flask-3.1.3` (commit 22d92470) | `pytest tests/test_cli.py` 58 passed; `git status` clean |

**Not yet done:** running inside VS Code (F5), any run with a real model, the video, the final write-up, a public repo, team registration.

---

## 3. Day-by-day

| Day | Goal | Done when |
|---|---|---|
| **Thu 12** | Register the team on techfest.org. Get API keys. F5 smoke test: panel opens, status bar shows model, inline diff renders. | Inline edit works end to end with the mock model in the editor |
| **Fri 13** | Task A with a real model. Polish streaming, CodeLens, undo. | Task A passes 5/5, `FLASK_DEBUG=off ... ` prints `False` |
| **Sat 14** | Task B with a real model. Tune agent instructions and retrieval until it reliably edits `cli.py`, `test_cli.py`, `docs/cli.rst` and pytest passes. | Task B passes 4/5 on primary model |
| **Sun 15** | **Registration closes: confirm.** Task C (invalid key, fallback). Cancel mid-Task-B and show rollback. | C passes; cancel leaves `git status` clean |
| **Mon 16** | Robustness: all 3 tasks x 5 runs x 2 models (one weak/free) to prepare for the organisers' live repeat. **Feature freeze at night.** | Failure log reviewed; no open P0 |
| **Tue 17** | Clean-clone test of README on a second teammate's machine. Write-up draft complete. | A teammate who did not build it runs all 3 tasks from README |
| **Wed 18** | Record the video (several takes, pick best). Note timestamps. | 4:00 or less, all verifications legible at 1080p |
| **Thu 19** | Final write-up PDF with timestamps; make repo public; check links from a logged-out browser. | All 3 links open without login |
| **Fri 20** | Submit by 18:00 IST. Post on LinkedIn/X/YouTube (optional prize). | Portal confirmation screenshot saved |

---

## 4. Rehearsal protocol (run exactly as judges will)

Reset before every run: `cd flask-3.1.3 && git checkout -- . && git clean -fd -e .venv && git status` (must be empty).

**Task A (inline).** Open `src/flask/helpers.py`, select `get_debug_flag`, Ctrl+Alt+I, paste:
> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Accept the hunks (reject one first in one take to show per-hunk). Verify:
`FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` must print `False`. Then show Undo once, then redo.

**Task B (agent).** New chat, no files mentioned:
> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Review hunks per file. Verify: `.venv/bin/python -m pytest tests/test_cli.py -q` passes; then `.venv/bin/flask --help` shows `config`; then `cd examples/tutorial && ../../.venv/bin/flask --app flaskr config` prints JSON with `"SECRET_KEY": "***"` (the tutorial app sets `SECRET_KEY="dev"`; verified it runs and leaves `git status` clean). Show the TrueForge session (panel "Session" link). `git diff --stat` shows 3+ files.

**Task C (resilience).** `node anvil/scripts/setup-models.mjs --break openai` (primary key becomes invalid), repeat Task A. Expect: status shows the failure, a retry, then "Falling back to <second model>"; diff still arrives; editor stays responsive. Reject all hunks or verify, then `git status` shows no changes. Restore: rerun `setup-models.mjs`.

Log every failed rehearsal in `docs/rehearsal-log.md`: model, task, what broke, fix.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Model fails Task B (wrong files, bad edits) | Paid primary for recording; pre-retrieval already ranks the right files; whitespace-tolerant edits; failed edits go back to the model with a hint; agent runs tests and fixes |
| Organisers repeat Task A live with **their** model, possibly weak or without tool calling | Inline edit uses an agent with **no tools** and a fenced-reply format, plus indentation repair and unfenced fallback, so it works on almost any chat model. Rehearse Task A on a small local or free model too |
| TrueForge changes under us | `start-trueforge.sh` pins `0.183.2`; SDK pinned `0.184.1` |
| Loopback blocked / IPv6 localhost | Handled in `start-trueforge.sh` and the default URL; documented in README |
| Free-tier limits (reported around 20 requests/day on Gemini Flash; Groq around 8k tokens/min) | Use free tiers only as fallback or for Task C; record on a paid primary (cost will be under a few dollars; declare it) |
| Deferred tool loading confuses a weak model (`run_command` not found) | If rehearsals show it, add `run_command` to `preload_tools` and say so in the write-up |
| VS Code UI bugs not yet seen | F5 smoke test today is the top priority |
| 10-minute code walkthrough before the shortlist is final | Everyone reads [WRITEUP.md](WRITEUP.md) section 3 and can explain: MCP bridge, approval -> review, retrieval scoring, fallback rule |

---

## 6. Roles (adjust to the team)

- **Editor UX:** review manager, inline edit, panel. Owns A1, A3, B2.
- **Agent + TrueForge:** service, controller, agent instructions, fallback. Owns A2, B3, B4.
- **Context:** retrieval quality, budget, context card. Owns B1 and Task B reliability.
- **Story:** video, write-up, scorecard, social posts. Owns C1, C2.
- **QA:** rehearsal matrix across models, clean-clone README test.

---

## 7. Submission checklist

- [ ] Team registered (by 15 Nov) and Team ID saved
- [ ] Repo public; README setup works from a clean clone; `LICENSE` present; "Starting point: from scratch" stated
- [ ] `config/models.example.json` present; no keys anywhere: `git log -p | grep -iE "sk-|api_key\"?: *\"[A-Za-z0-9]"` is empty
- [ ] Agent definitions in `extension/agents/`
- [ ] Video: 4:00 or less, order A, B, C, each verified; TrueForge session shown in B; no cut between instruction and diff; public link (YouTube unlisted or Drive "anyone with link")
- [ ] Write-up PDF, 1-3 pages, the 8 headings in order, scorecard timestamps match the final video
- [ ] All three links opened from a logged-out browser
- [ ] Submitted before 18:00 IST, 20 Nov
