#!/usr/bin/env bash
# Reset everything between video takes:
#   - Flask back to the pinned commit with no changes (keeps .venv and .vscode)
#   - real model keys restored in TrueForge (undoes the Task C "--break")
#   - prints the exact commands to paste during the recording
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FLASK="${FLASK_DIR:-$HERE/../flask-3.1.3}"

cd "$FLASK"
git checkout -q -- .
git clean -fdq -e .venv -e .vscode
rm -rf examples/tutorial/instance
echo "Flask reset at $(git rev-parse --short HEAD). git status: '$(git status --short)' (empty = clean)"

node "$HERE/scripts/setup-models.mjs" --workspace "$FLASK" | grep -E "ok|FAIL|BROKE"

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
git checkout -- . && node ../anvil/scripts/setup-models.mjs --break anthropic
git status
---------------------------------------------------------------------------
EOF
