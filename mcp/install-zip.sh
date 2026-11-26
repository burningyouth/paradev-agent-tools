#!/bin/sh
set -eu

case "${1:-}" in
  -h|--help)
    printf '%s\n' 'sh Install.sh [codex|opencode-auto|opencode|opencode-v1|opencode-paradev|kilo|manual]' \
      'Для opencode-paradev укажите --workspace ПУТЬ и при необходимости --profile ПУТЬ.' \
      'Откройте без аргументов в терминале, чтобы выбрать клиент.'
    exit 0 ;;
esac

root=$(CDPATH= cd -P -- "$(PATH=/usr/bin:/bin dirname -- "$0")" && pwd)
exec "$root/paradev-agent-tools/launch" --install --zip "$@"
