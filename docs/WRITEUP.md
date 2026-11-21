# Anvil: write-up (draft)

> Markdown copy of the submitted write-up. The PDF is [writeup.pdf](writeup.pdf).

## 1. Team

Team **teamMeowMan()**

| Member | Role | College / employer | GitHub |
|---|---|---|---|
| Gagan Deep | Leader | VIT-AP | [gaghackz](https://github.com/gaghackz) |
| Shaunak Choudhury | Member | VIT-AP | [shaunakc11](https://github.com/shaunakc11) |
| Malika Farah | Member | VIT-AP | [malikafarah](https://github.com/malikafarah) |

## 2. Starting point

From scratch (no fork). We read Continue, Cline, Roo Code and opencode first. Roo Code was archived in May 2026, and opencode is a terminal app. Continue's diff renderer and Cline's task loop are tightly coupled to their own LLM layers, telemetry and webview protocols, so a fork would have meant mostly deleting code. We wanted a small codebase where every line is about the two things this competition scores: context assembly and a safe editor. Runtime dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff` (jsdiff). For per-hunk review we reuse VS Code's own diff editor rather than writing a renderer.

## 3. Architecture on TrueForge

- **Client.** The extension is a TrueForge SDK client. Inline edits and agent requests are turns on TrueForge sessions; the panel renders the SSE events (`model.message.delta`, `tool.response`, `thread.created/done`, `tool.approval_required`, `turn.done`). The extension contains no model-provider code.
- **Editor as MCP.** On activation the extension starts a streamable-HTTP MCP server on `127.0.0.1` with a per-launch bearer token and registers it in TrueForge as `anvil-editor`. Tools: `retrieve_context`, `read_file`, `search_code`, `find_symbol`, `list_files` (annotated read-only) and `edit_file`, `write_file`, `run_command` (annotated as writes).
- **Approval drives review.** The agent definition sets `require_approval_for_tools: [edit_file, write_file, run_command]`. When TrueForge pauses on a write, Anvil applies the proposed edits in memory, opens the diff editor, and waits for a decision on every hunk. If any hunk is accepted it sends `allow`; TrueForge then executes the call on our MCP server, which writes exactly the accepted hunks in one atomic `WorkspaceEdit`. All rejected sends `deny` with the reason. The tool result tells the agent which hunks were rejected. A write with no matching review is refused, keyed by a canonical hash of the call's arguments, so a misconfigured approval policy still cannot write silently.
- **Harness features used.** *Deferred tool loading*: the five tools needed on every request are preloaded; `run_command`, `find_symbol` and `list_files` load on demand, which keeps their schemas out of most model calls (visible in the session as `list_tools`/`call_tool`). *Subagents*: enabled; the agent may delegate discovery ("where are commands implemented, tested, documented") to a subagent, so only the summary returns to the main context. Subagent threads render in the panel. *Compaction*: triggers at 60k input tokens for long runs.
- **Agent definitions** live in `extension/agents/` and are registered per configured model (`anvil-coder-<model>`, `anvil-inline-<model>`).

## 4. How context is selected

Explicit first, then retrieved, always under a budget (default 10k tokens for agent mode, 2.5k for inline).

1. `@file:` and `@sym:` mentions are included first (whole file if under the per-file cap, otherwise an outline; a symbol includes its defining chunk).
2. The workspace is indexed on startup (Flask: 214 files, 1,554 chunks, 985 symbols in about 0.3s) into syntax-aware chunks (functions, classes, methods, doc sections), a symbol table and a Python import graph, refreshed on file change.
3. Files are ranked by BM25 over chunks, plus path matches, exact code identifiers from the request, and **analogues**: for "add a new X", the files that already define several X's (for Task B, `cli.py` defines `routes_command`, `shell_command`, `run_command`...).
4. Structural expansion: if the request asks for tests or docs, the test counterpart (`tests/test_cli.py`) and the doc page for the anchor module (`docs/cli.rst`) are pulled in.
5. Packing is breadth-first: every selected file gets its single best view before any file gets a second chunk, so companions are never starved. Remaining budget goes to more chunks of top files, then signature outlines.
6. Every item carries its reasons, and the panel shows them with the token count and what was left out. For Task B the top three files are exactly the three that must change (regression-tested).

Trade-off: lexical plus structural retrieval, not embeddings. It is deterministic, instant, needs no extra model or service (out of scope here), and explains itself. Its weakness is vocabulary mismatch, which the agent covers with `search_code` and `find_symbol`.

## 5. Model setup

| Role | Model (TrueForge name) | Where it runs | Used for |
|---|---|---|---|
| Primary | `anthropic/claude-sonnet-5-5` | Anthropic API via TrueForge's `anthropic` catalog provider | Tasks A and B |
| Fallback | `anthropic-compat/claude-haiku-5-5` | Anthropic's OpenAI-compatible endpoint, registered as a separate `custom` provider | Task C (after the primary key is made invalid) |
| Development | `mock/mock-coder` | `scripts/mock-llm.mjs`, a scripted OpenAI-compatible server on localhost | All automated tests; costs nothing |

The fallback deliberately goes through a different provider entry so that breaking the primary's key (Task C) does not take the fallback down with it. Measured on our runs: Task A about 3s and Task B about 50s on Sonnet 5.5; Task B used about 329k input tokens (mostly prompt-cache reads) and 6.4k output tokens, under $0.75 even at uncached prices. Total model spend for development, rehearsals and recording: under $5.

Switching models: `anvil.models` (ordered list of TrueForge model names) or **Anvil: Select Model Order**. Keys live only in TrueForge (`scripts/setup-models.mjs` reads them from env vars). Any catalog provider or OpenAI-compatible endpoint works; nothing in the extension is provider-specific. Inline edit uses a tool-free agent and a plain fenced-reply format, so it works on models with weak or no tool calling.

**Resilience:** a failed turn that produced nothing is safe to replay, so Anvil retries the same model with exponential backoff, then opens a fresh session on the next model, with no user action. A run that has already acted is never replayed automatically. TrueForge's own HTTP retries also apply underneath.

## 6. Scorecard

Video: https://youtu.be/Kvxol8ji1ek (3:17)

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | 1:00 | Diff streams into the editor (1:08); hunks accepted one by one (1:10-1:14); check prints `False` (1:18) |
| A2 Agent mode | 1:22 | No files named; agent edits `cli.py`, `test_cli.py`, `docs/cli.rst`, `CHANGES.rst`; pytest 61 passed (2:00); `git diff --stat` 4 files (2:06) |
| A3 Streaming and cancellation | 0:44 | Edit starts streaming and is stopped mid-generation (0:56); file untouched (0:58) |
| B1 Context assembly | 1:25 | Context card: each chosen file, why, and tokens against a 10k budget |
| B2 Diff safety | 1:10, 1:40 | Per-hunk review, one file at a time; nothing written before review. Undo exists but is not exercised in the video |
| B3 Resilience | 2:20 | Primary key invalidated; retry, then automatic fallback to Haiku (2:35), diff arrives (2:40); `git status` clean (2:45) |
| B4 TrueForge integration | 1:54, 2:10 | MCP tool call needing approval (run_command, Allow) at 1:54; TrueForge session at 2:10 |

## 7. Tools used

Claude Code.

## 8. Known limitations

Verified on the real model: Task A edits code and docstring in 2 hunks; Task B changed `cli.py`, `tests/test_cli.py`, `docs/cli.rst` and also `CHANGES.rst` unprompted, `pytest tests/test_cli.py` went from 58 to 61 passing; Task C fell back to Haiku in about 5s with `git status` clean. Limitations:
- Retrieval is lexical and structural; no embeddings, so synonym-only matches rely on the agent's own searching.
- Symbol extraction is regex-based (Python, JS/TS), not a language server.
- A fallback mid-run is deliberately not automatic once the run has written files or run commands.
- Partial accept within one hunk is not supported (whole hunks only).

With another month: language-server symbols and references, an embedding re-ranker behind the lexical stage, transcript hand-off on fallback, and a TrueForge PR for built-in model fallback chains in agent specs.
