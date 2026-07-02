#!/usr/bin/env bash
export NODE_PATH="$(npm root -g)"
exec node "$(dirname "$0")/switch-mode.js" "$@"
