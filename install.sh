#!/bin/sh
set -eu

case "${1:-}" in
  -h|--help)
    printf '%s\n' './install.sh [codex|opencode-auto|opencode|opencode-v1|opencode-paradev|kilo|manual]' \
      'Запустите без аргументов в терминале, чтобы выбрать клиент.' \
      'Для opencode-paradev укажите --workspace ПУТЬ и при необходимости --profile ПУТЬ.'
    exit 0 ;;
esac

root=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
command -v git >/dev/null 2>&1 || { echo 'Установите Git.' >&2; exit 1; }
command -v go >/dev/null 2>&1 || { echo 'Установите Go 1.26+.' >&2; exit 1; }
(cd "$root" && go run ./cmd/pack -dev >&2)
exec "$root/dist/dev/plugins/paradev-agent-tools/launch" --install --dev "$@"
