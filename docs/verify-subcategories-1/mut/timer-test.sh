#!/bin/bash
# Test for the ceiling-timer clear: a fast-resolving fetchTopicPayload with a 60s ceiling must let the
# process exit in well under 5s. Prints "PASS timer-cleared" or "FAIL timer-cleared".
out=$(bash /tmp/claude-0/-home-user/9b1b1e84-4ea7-5992-8b1c-861fe3bdcec7/scratchpad/timer.sh 2>&1)
wall=$(printf '%s' "$out" | sed -n 's/.*wall=\([0-9]*\)ms.*/\1/p')
echo "$out"
if [ -n "$wall" ] && [ "$wall" -lt 5000 ]; then echo "PASS timer-cleared"; else echo "FAIL timer-cleared"; exit 1; fi
