#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(PATH=/usr/bin:/bin dirname -- "$0")" && pwd)
exec "$root/multi-agent-mcp/launch" --install "$@"
