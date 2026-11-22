#!/bin/bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
    printf 'Usage: bash BeatTheBoardUITests/run.sh "platform=iOS Simulator,id=SIMULATOR_UUID" [xcodebuild options]\n' >&2
    exit 64
fi

destination=$1
shift
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/beat-the-board-ui.XXXXXX")
node BeatTheBoardUITests/fixture-server.mjs 0 > "$test_dir/fixture.log" 2>&1 &
fixture_pid=$!

stop_fixture() {
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
}
trap stop_fixture EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fixture_url=''
for ((attempt = 0; attempt < 100; attempt++)); do
    fixture_url=$(awk '/^http:\/\/127\.0\.0\.1:[0-9]+$/ { print; exit }' "$test_dir/fixture.log")
    if [[ -n "$fixture_url" ]]; then break; fi
    if ! kill -0 "$fixture_pid" 2>/dev/null; then break; fi
    sleep 0.1
done

if [[ -z "$fixture_url" ]]; then
    cat "$test_dir/fixture.log" >&2
    printf 'The UI test fixture could not start. Build artifacts and logs are in %s.\n' "$test_dir" >&2
    exit 1
fi

printf 'UI test results and fixture log: %s\n' "$test_dir"
TEST_RUNNER_BTB_TEST_SERVER_URL="$fixture_url" xcodebuild \
    -project BeatTheBoard.xcodeproj \
    -scheme BeatTheBoard \
    -destination "$destination" \
    -derivedDataPath "$test_dir/DerivedData" \
    -resultBundlePath "$test_dir/Results.xcresult" \
    -parallel-testing-enabled NO \
    "$@" test
