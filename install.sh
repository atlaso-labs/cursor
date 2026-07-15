#!/usr/bin/env bash
# Install the Atlaso Cursor PLUGIN locally for dev / testing (before it's on the
# Marketplace). A Cursor plugin is just FILES — there is NO build step — so this
# copies the plugin into Cursor's local-plugins location; Cursor loads it like any
# Marketplace plugin and sets ${CURSOR_PLUGIN_ROOT} to the installed path.
#
#   ./install.sh                    # → ~/.cursor/plugins/local/atlaso
#   ./install.sh /custom/.cursor    # → /custom/.cursor/plugins/local/atlaso
#
# Once it's on the Marketplace, end users run `/add-plugin atlaso` instead.
# Requires: bun (Cursor ships it; local runs need it on PATH).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CURSOR_DIR="${1:-$HOME/.cursor}"
DEST="$CURSOR_DIR/plugins/local/atlaso"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
( cd "$HERE" && cp -R . "$DEST/" )
# strip dev-only bits from the installed copy
rm -rf "$DEST/tests" "$DEST/install.sh" "$DEST/dist" "$DEST/node_modules" 2>/dev/null || true

command -v bun >/dev/null 2>&1 || \
  echo "WARNING: 'bun' not found on PATH. Cursor provides it for plugins, but local runs need it."

echo "installed → $DEST"
echo "Next: reload Cursor (Cmd+Shift+P → Reload Window), then Settings → Plugins →"
echo "      enable \"Atlaso Memory\" if it isn't on (local plugins may need a toggle)."
echo "It registers: sessionStart recall + stop/sessionEnd capture hooks, a usage rule, and the memory skill."
echo "Uninstall: rm -rf \"$DEST\""
