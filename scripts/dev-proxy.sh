#!/usr/bin/env bash
# Start claude-max-api-proxy with auth check.

set -euo pipefail

PORT="${LLM_PROXY_PORT:-3456}"

echo "Starting claude-max-api-proxy on port $PORT..."

if ! claude --version >/dev/null 2>&1; then
  echo ""
  echo "ERROR: Claude CLI not found or not working."
  echo "Install it: npm install -g @anthropic-ai/claude-code"
  echo "Then authenticate: claude"
  exit 1
fi

npx claude-max-api-proxy "$PORT" 2>&1 &
PROXY_PID=$!

sleep 3

if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo ""
  echo "ERROR: claude-max-api-proxy failed to start."
  echo ""
  echo "This usually means Claude CLI authentication is missing or expired."
  echo "Fix it by running:  claude"
  echo "Then retry:         pnpm dev"
  exit 1
fi

echo "claude-max-api-proxy running (PID $PROXY_PID) on port $PORT"
wait "$PROXY_PID"
