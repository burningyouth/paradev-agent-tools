#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=darwin-arm64 ;;
  Linux:x86_64) target=linux-amd64 ;;
  *) printf '%s\n' "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

binary="$root/bin/$target"
if [ ! -x "$binary" ]; then
  printf '%s\n' "Missing executable: $binary" >&2
  exit 1
fi
exec "$binary" "$@"
