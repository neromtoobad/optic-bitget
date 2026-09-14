#!/bin/zsh
# Dev server launcher for the desktop preview: pins the user-local Node (no
# Homebrew on this Mac) and runs from the project root so .env and SITE_DIR resolve.
cd "$(dirname "$0")/.." || exit 1
exec /Users/MAC/.local/node-v24.21.0/bin/node node_modules/.bin/tsx watch src/server.ts
