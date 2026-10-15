#!/usr/bin/env bash
# Scans the FULL git history for committed secret values. Prints CLEAN on
# zero matches; otherwise prints the match count and exits non-zero.
#
# Patches are matched against secret-patterns.ere, the same set the pre-publish
# tarball scan (scripts/pack-inspect.mjs) uses. The files that define the
# patterns are excluded, or the regex would match itself.
#
# Commit messages are scanned separately against secret-message-patterns.ere,
# which only matches complete credentials (whole GitHub/npm tokens, an AWS
# secret key with its value): a message that names a token prefix, quotes an
# access-key ID or mentions a PEM header is not a hit.
#
# A failure to read the history or to run grep aborts the script instead of
# counting as zero matches.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "secret scan aborted: shallow clone, the history is incomplete (fetch with --unshallow or fetch-depth 0)" >&2
  exit 2
fi

count_matches() {
  local matches status
  matches="$(grep -cEf "$1")" && status=0 || status=$?
  if [ "$status" -le 1 ]; then
    echo "$matches"
    return 0
  fi
  echo "secret scan aborted: grep failed with status $status on $1" >&2
  exit 2
}

patches="$(git log --all --format= -p -- . ':(exclude)scripts/secret-scan.sh' ':(exclude)scripts/secret-patterns.ere' ':(exclude)scripts/secret-message-patterns.ere')"
messages="$(git log --all --format=%B)"

patch_count="$(count_matches scripts/secret-patterns.ere <<<"$patches")"
message_count="$(count_matches scripts/secret-message-patterns.ere <<<"$messages")"

if [ "$patch_count" = "0" ] && [ "$message_count" = "0" ]; then
  echo CLEAN
else
  echo "DIRTY: $patch_count secret-pattern matches in patches, $message_count complete credentials in commit messages" >&2
  exit 1
fi
