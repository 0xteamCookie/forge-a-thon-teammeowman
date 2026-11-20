# Anvil

A coding agent for VS Code whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge). Built for the TrueForge Forge-a-thon (Techfest 2026-27, IIT Bombay).

## Round 1 submission: teamMeowMan() · TM-19DE4C2ACA5

| Artefact | Link |
|---|---|
| Demo video (Tasks A, B, C) | **VIDEO LINK** |
| Write-up (PDF, 3 pages) | [docs/writeup.pdf](docs/writeup.pdf) |
| Code | This repository |

Team: Gagan Deep (leader), Shaunak Choudhury, Malika Farah.

Anvil reads a real repository, decides what the model should see, plans a change across several files, and shows every hunk for review before anything touches disk. If the model behind it fails, it retries and then falls back to the next configured model on its own.

## Starting point

**From scratch.** No upstream fork. We evaluated forking Continue, Cline, Roo Code and opencode (see [docs/WRITEUP.md](docs/WRITEUP.md#2-starting-point) for why we didn't). Runtime dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff` (jsdiff).

## How it fits together

```
VS Code extension (this repo)                       TrueForge (local mode, npx)
┌──────────────────────────────────────┐           ┌───────────────────────────────┐
│ Agent panel / inline edit            │──SDK─────▶│ sessions, turns, SSE events   │
│  renders streamed events             │◀─stream───│ agent loop, subagents,        │
│ Context engine (index, BM25, budget) │           │ deferred tool loading,        │
│ Review manager (per-hunk diff, undo) │           │ compaction, tool approval     │
│ MCP server on 127.0.0.1 (bearer)     │◀──MCP─────│ calls editor tools            │
└──────────────────────────────────────┘           └──────────────┬────────────────┘
                                                                  │ any model: catalog
                                                                  ▼ provider or OpenAI-compatible
```

The extension never calls a model provider. Editor capabilities (read, search, retrieve context, write, run a command) are MCP tools, so the agent decides what to read and change. Write and command tools are annotated as writes, so TrueForge's approval gate pauses on them, and Anvil turns that pause into the hunk-by-hunk review.

## Setup (from a clean clone)

Requirements: Node 22.14+, VS Code 1.95+, git, Python 3.9+ (for the Flask tasks).

```bash
git clone <this repo> anvil
git clone --branch 3.1.3 https://github.com/pallets/flask flask-3.1.3   # next to anvil/
cd flask-3.1.3 && python3 -m venv .venv && .venv/bin/pip install -e . "pytest==8.4.2" asgiref python-dotenv && cd ..
# pytest 8.4.2 is what Flask 3.1.3's uv.lock pins; pytest 9 breaks tests/test_cli.py (removed private import).

# 1. Start TrueForge locally (keep this terminal open)
./anvil/scripts/start-trueforge.sh
#    UI at http://localhost:8790

# 2. Register models (keys come from env vars; nothing secret is written to disk by us)
cp anvil/config/models.example.json anvil/config/models.json   # edit providers/models
export OPENAI_API_KEY=...  GROQ_API_KEY=...                       # whichever you use
node anvil/scripts/setup-models.mjs --workspace flask-3.1.3

# 3. Build and launch the extension
cd anvil/extension && npm install && npm run build && cd ..
code anvil      # then press F5: "Run Anvil on Flask 3.1.3"
```

On activation Anvil starts its MCP server on `127.0.0.1:7801`, registers it in TrueForge as `anvil-editor` (with a per-launch bearer token), and creates one TrueForge agent per configured model from the definitions in [`extension/agents/`](extension/agents).

### Two TrueForge details that will otherwise cost you an hour

1. **Loopback is blocked by default.** TrueForge's outbound URL guard rejects `127.0.0.0/8` and `*.localhost`, so it cannot reach a local MCP server or Ollama. `start-trueforge.sh` sets `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`, which allows only loopback.
2. **Local mode listens on IPv6 `[::1]`.** Use `http://localhost:8790`, not `127.0.0.1:8790`.

## Using it

| | |
|---|---|
| Inline edit | Select code, `Ctrl+Alt+I` (`Cmd+Alt+I`), type the instruction. The diff streams in; Accept/Reject above each hunk (`Ctrl+Alt+Y` / `Ctrl+Alt+N`). `Esc` stops. |
| Agent mode | Anvil panel in the activity bar. One request; the agent finds files itself. `@file:path` and `@sym:Name` add explicit context (autocomplete on `@`). |
| Review | Every write opens VS Code's diff editor: left is what will be written, right is the proposal. Accept or reject each hunk; nothing is written until all are decided. |
| Undo | The Undo button on each applied change, or **Anvil: Undo Last Applied Change**. Stopping a run rolls back what that run wrote. |
| Models | Status bar item, or **Anvil: Select Model Order**. First model is primary; the rest are automatic fallbacks. Setting: `anvil.models`. |
| TrueForge session | "Session" in the panel header opens the run in the TrueForge UI (turns, tool calls, subagents). |

## Model configuration

`config/models.example.json` shows OpenAI, Gemini, Groq (OpenAI-compatible) and Ollama (local). Anvil itself only knows model names like `openai/gpt-4-1-mini`; keys live in TrueForge. Any model TrueForge can call works, and no code path depends on a specific provider.

## Development

```bash
cd extension
npm run typecheck
npm test                                   # unit tests (hunks, edits, parsing, retrieval)
ANVIL_FIXTURE=../../flask-3.1.3 npm test   # + retrieval regression on Flask
# live loop against TrueForge with a scripted mock model (no credits):
node ../scripts/mock-llm.mjs &  MOCK_PORT=7901 MOCK_FAIL=401 node ../scripts/mock-llm.mjs &
node ../scripts/setup-mock-providers.mjs && npm run e2e
```

## Licence

MIT. See [LICENSE](LICENSE).
