# Setting up a machine to record the demo

About 20 minutes the first time. Linux or macOS (on Windows, use WSL). Then follow [DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## You need
- git, VS Code, Python 3.10+, OBS (or any screen recorder)
- **Node 22.14 or newer** (`node -v`). If older: install nvm, then `nvm install 22 && nvm use 22`
- **Your own Anthropic API key** (from console.anthropic.com). The demo costs well under $1 per take.

## One-time setup

Put both repos side by side in one folder:

```bash
mkdir forgeathon && cd forgeathon
git clone https://github.com/0xteamCookie/forge-a-thon-teammeowman anvil
git clone --branch 3.1.3 https://github.com/pallets/flask flask-3.1.3

# Flask's test environment (pytest 8.4.2 exactly: pytest 9 breaks tests/test_cli.py)
cd flask-3.1.3
python3 -m venv .venv
.venv/bin/pip install -e . "pytest==8.4.2" asgiref python-dotenv
cd ..

# Build the extension
cd anvil/extension && npm install && npm run build && cd ../..
```

## Every recording session

**Terminal 1** (leave it running):
```bash
./anvil/scripts/start-trueforge.sh
```
Wait for `Agent server listening on http://localhost:8790`.

**Terminal 2**:
```bash
export ANTHROPIC_API_KEY=sk-ant-...      # never commit or show this on screen
./anvil/scripts/demo-reset.sh
```
It resets Flask, registers the two models in TrueForge, sets large fonts, and prints every line you paste during the video. **Run it again before every take.**

**Launch:** `code anvil`, then press **F5** ("Run Anvil on Flask 3.1.3"). A second VS Code window opens on Flask with Anvil loaded. Record in that window. The status bar should show `Anvil · anthropic/claude-sonnet-5-5 (+1 fallback)`.

## Before the first take (2 minutes)
1. Anvil panel (activity bar, anvil icon) shows "Connected to TrueForge".
2. Do Task A once untimed. The diff should appear within a few seconds.
3. Run `demo-reset.sh` again, then start recording.

## If something goes wrong
| Symptom | Fix |
|---|---|
| Panel says TrueForge not reachable | Terminal 1 not running, or Node older than 22 |
| `ANTHROPIC_API_KEY is not set` | `export` it in the same terminal before `demo-reset.sh` |
| No diff appears, error mentions 401 | The key is wrong, or Task C's `--break` is still active: run `demo-reset.sh` |
| `git status` not clean | Run `demo-reset.sh` |
| pytest fails to collect `test_cli.py` | Wrong pytest version: `.venv/bin/pip install "pytest==8.4.2"` |
| Anything else | Message Shaunak with a screenshot |

Hide the API key: don't `echo` it, and close any terminal that shows it before you start recording.
