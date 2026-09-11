#!/usr/bin/env bash
# The gate before any release: every suite, in one command.
#
#   bash tools/run-tests.sh
#
# Offline. Nothing here sends mail or touches a live store: both suites build a
# throwaway store under the OS temp dir and delete it. The HTTP suite boots a real
# server on a spare port so the webhook, the auth boundary and the dashboard
# endpoint are exercised as the provider would.
set -u
cd "$(dirname "$0")/.."
fail=0

echo "== store: engagement, failures, the event queue =="
node tests/engagement_store_test.cjs || fail=1

echo
echo "== http: webhook -> store -> /api/tracking, and the client it serves =="
node tests/tracking_http_test.cjs || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL SUITES PASSED"
else
  echo "FAILURES ABOVE — do not ship this"
fi
exit "$fail"
