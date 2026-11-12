#!/usr/bin/env bash
# Scans the files tracked by git for things that must never be committed (keys, tokens, real .env).
# Exit code 1 when something suspicious is found. Run before every push: pnpm secret:scan
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
files=$(git ls-files --cached --others --exclude-standard)

bad_paths=$(echo "$files" | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$' || true)
bad_paths+=$(echo "$files" | grep -E '\.(key|pem|pfx|p12)$' || true)
if [ -n "$bad_paths" ]; then
  echo "✗ sensitive files are tracked:"; echo "$bad_paths"; status=1
fi

patterns='(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|untrusted comment: rsign encrypted secret key|dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5|AKIA[0-9A-Z]{16}|postgres://[^:]+:[^@]{1,}@(?!127\.0\.0\.1|localhost|postgres|change-me))'
hits=$(echo "$files" | xargs grep -nIP "$patterns" 2>/dev/null | grep -v 'scripts/secret-scan.sh' || true)
if [ -n "$hits" ]; then
  echo "✗ possible secrets:"; echo "$hits"; status=1
fi

if [ $status -eq 0 ]; then echo "✓ secret scan clean ($(echo "$files" | wc -l) tracked files)"; fi
exit $status
