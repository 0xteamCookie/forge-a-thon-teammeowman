#!/usr/bin/env bash
# Reset everything between video takes:
#   - Flask back to the pinned commit with no changes (keeps .venv and .vscode)
#   - real model keys restored in TrueForge (undoes the Task C "--break")
#   - prints the exact commands to paste during the recording
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FLASK="${FLASK_DIR:-$HERE/../flask-3.1.3}"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "No API key set. Run ONE of:  export ANTHROPIC_API_KEY=sk-ant-...   or   export OPENAI_API_KEY=sk-..." >&2
  exit 1
fi
cd "$FLASK"
# Workspace settings must never show up in `git status` (Task C checks it).
grep -qxF ".vscode/" .git/info/exclude 2>/dev/null || echo ".vscode/" >> .git/info/exclude
git checkout -q -- .
git clean -fdq -e .venv -e .vscode
rm -rf examples/tutorial/instance
echo "Flask reset at $(git rev-parse --short HEAD). git status: '$(git status --short)' (empty = clean)"

if ! node "$HERE/scripts/setup-models.mjs" --workspace "$FLASK"; then
  echo "Model setup failed (see FAIL lines above). Fix that before recording." >&2
  exit 1
fi
# Readable on video: larger fonts, no minimap.
node -e '
const fs=require("fs"),p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));
Object.assign(s,{"editor.fontSize":16,"terminal.integrated.fontSize":16,"window.zoomLevel":0.5,"editor.minimap.enabled":false,"workbench.startupEditor":"none","breadcrumbs.enabled":false});
fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")' "$FLASK/.vscode/settings.json"

cat <<'EOF'

--- paste during recording -------------------------------------------------
Task A instruction:
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Task A check:
FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"

Task B instruction:
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Task B checks:
.venv/bin/python -m pytest tests/test_cli.py -q
.venv/bin/flask --help
(cd examples/tutorial && ../../.venv/bin/flask --app flaskr config | head -25)
git diff --stat

Task C (break the primary model, then repeat Task A):
git checkout -- . && node ../anvil/scripts/setup-models.mjs --break primary
git status
---------------------------------------------------------------------------
EOF
