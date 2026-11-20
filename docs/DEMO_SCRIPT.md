# Demo video script (4:00 max)

Rules from the PS: tasks A, B, C in that order, each followed by its on-screen check; TrueForge session shown briefly during B; model waiting time may be cut, but **never cut between giving an instruction and the diff appearing**. 1080p, editor font 16+, terminal font 16+, light or dark theme with good contrast. Captions optional; we add short lower-third captions naming each rubric item.

Layout: VS Code left 70% (editor + Anvil panel on the right side bar), integrated terminal at the bottom. TrueForge UI in a browser tab, ready.

| Time | Shot | Caption |
|---|---|---|
| 0:00-0:08 | Title card: "Anvil: a coding agent on TrueForge". Status bar shows `Anvil · <primary> (+1 fallback)`. | |
| **Task A** | | |
| 0:08-0:16 | Open `src/flask/helpers.py`, select `get_debug_flag`, Ctrl+Alt+I, type any instruction, and press **Esc** while the diff is filling. Diff closes, file untouched. | Cancellation (A3) |
| 0:16-0:24 | Select `get_debug_flag` again, Ctrl+Alt+I, paste the exact Task A instruction. | A. Inline edit |
| 0:20-0:35 | Diff editor opens and fills as tokens stream (do not cut). Hover the CodeLens. | Streaming from TrueForge |
| 0:35-0:45 | Reject one hunk (e.g. a cosmetic one), accept the others. Notification "applied 2 of 3 hunks · Undo". | Per-hunk accept / reject |
| 0:45-0:55 | Terminal: `FLASK_DEBUG=off .venv/bin/python -c "..."` prints `False`. | Verified |
| 0:55-1:02 | Click Undo, show file reverted, Ctrl+Shift+Z or re-run accept (or just show undo then redo via command). | Undo of an applied change |
| **Task B** | | |
| 1:02-1:12 | Anvil panel, paste the exact Task B instruction, no files named. | B. Agent mode |
| 1:12-1:30 | Context card expands: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` with reasons and a token budget meter. | Context: files chosen and why, within budget |
| 1:30-1:55 | Tool rows stream (retrieve_context, read_file...). Cut waiting time only. | |
| 1:55-2:30 | Review cli.py hunks, accept; test_cli.py, accept; cli.rst, accept. Each opens in the diff editor. | Approval in TrueForge drives the diff review |
| 2:30-2:45 | Agent asks to run pytest: Allow. Output shows pass. | |
| 2:45-3:00 | Terminal: `pytest tests/test_cli.py -q` passed; `flask --help` lists `config`; `flask --app flaskr config` shows `"SECRET_KEY": "***"`; `git diff --stat` shows 3 files. | Verified |
| 3:00-3:12 | Click "Session": TrueForge UI shows the turns, MCP tool calls, deferred tool loading, subagent if used. | TrueForge session |
| **Task C** | | |
| 3:12-3:20 | Terminal: `node scripts/setup-models.mjs --break openai` (shows "BROKE openai"). `git checkout -- .` to reset. | C. Resilience |
| 3:20-3:42 | Repeat Task A. Status bar: "failed (401) retrying in 1s", then "Falling back to <model2>". Click around the editor during this to show it's responsive. Diff arrives. | Automatic fallback, editor responsive |
| 3:42-3:55 | Reject all hunks. Terminal: `git status` shows nothing. | Workspace unchanged |
| 3:55-4:00 | End card: repo URL. | |

Optional extra if time allows: press Stop mid-Task-B and show "Rolled back N file writes"; `git status` clean.

Before recording: reset Flask (`git checkout -- . && git clean -fd -e .venv`), close unrelated tabs, hide personal info from the window title and terminal prompt, set Do Not Disturb, run the whole sequence once untimed.
