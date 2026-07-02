#!/usr/bin/env bash
# Copy gitignored agent files from personal-agent-system-setup into this repo.
# Safe to re-run; overwrites templates with fresh copies.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP_ROOT="${PERSONAL_AGENT_SYSTEM_SETUP:-$HOME/Documents/personal-agent-system-setup}"
TEMPLATES="$SETUP_ROOT/templates"

if [[ ! -d "$TEMPLATES" ]]; then
  echo "Missing templates at: $TEMPLATES" >&2
  echo "Set PERSONAL_AGENT_SYSTEM_SETUP to your personal-agent-system-setup clone." >&2
  exit 1
fi

copy() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  → ${dst#$REPO_ROOT/}"
}

echo "Bootstrapping agent files in $REPO_ROOT"
echo "From: $TEMPLATES"
echo

copy "$TEMPLATES/AGENTS.md" "$REPO_ROOT/AGENTS.md"
copy "$TEMPLATES/BACKLOG.md" "$REPO_ROOT/BACKLOG.md"
copy "$TEMPLATES/SNAPSHOT.md" "$REPO_ROOT/SNAPSHOT.md"

mkdir -p "$REPO_ROOT/.agents/rules" "$REPO_ROOT/.agents/skills"
copy "$TEMPLATES/.agents/rules/git-commits.md" "$REPO_ROOT/.agents/rules/git-commits.md"
copy "$TEMPLATES/.agents/rules/notifications.md" "$REPO_ROOT/.agents/rules/notifications.md"
copy "$TEMPLATES/.agents/rules/incremental-verifiable-work.md" \
  "$REPO_ROOT/.agents/rules/incremental-verifiable-work.md"

HOOK_SRC="$SETUP_ROOT/templates/githooks/commit-msg"
HOOK_DST="$REPO_ROOT/.git/hooks/commit-msg"
if [[ -f "$HOOK_SRC" ]]; then
  cp "$HOOK_SRC" "$HOOK_DST"
else
  cat > "$HOOK_DST" <<'EOF'
#!/bin/sh
tmp=$(mktemp)
grep -v -E '^Co-authored-by: Cursor <cursoragent@cursor.com>$' "$1" > "$tmp"
mv "$tmp" "$1"
EOF
fi
chmod +x "$HOOK_DST"
echo "  → .git/hooks/commit-msg"

cat > "$REPO_ROOT/SNAPSHOT.md" <<'EOF'
# Snapshot

**Updated:** 2026-07-02

## In Progress

- _None._

## Blocked

- _None._

## Next

1. Run `npm run collect` for new date ranges as needed.
2. Keep agent setup local: re-run `./scripts/bootstrap-agent-setup.sh` after template updates.
EOF

cat > "$REPO_ROOT/BACKLOG.md" <<'EOF'
# Backlog

## Next

- [ ] _(none)_

## Soon

- [ ] _(none)_

## Later

- [ ] _(none)_
EOF

echo
echo "Done. Agent files are gitignored — they stay local only."
echo "Read AGENTS.md and .agents/rules/git-commits.md before agent commits."
