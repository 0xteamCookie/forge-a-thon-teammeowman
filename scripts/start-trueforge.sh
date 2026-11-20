#!/usr/bin/env bash
# Start TrueForge in local mode for Anvil.
#
# OUTBOUND_URL_ALLOWED_HOSTS is required: TrueForge's outbound URL guard blocks loopback
# addresses by default, and Anvil's editor MCP server (and Ollama, if used) live on 127.0.0.1.
# Only loopback is allowed; everything else keeps TrueForge's default protection.
set -euo pipefail
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "TrueForge needs Node >= 22.14 (found $(node -v)). Try: nvm use 22" >&2
  exit 1
fi
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
exec npx -y @truefoundry/trueforge@${TRUEFORGE_VERSION:-0.183.2} "$@"
