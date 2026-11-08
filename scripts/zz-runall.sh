#!/bin/bash
cd "$(dirname "$0")/.."
OUT=/tmp/claude-0/-home-user/6b92c74f-b63e-5103-ab85-5f148e3b8912/scratchpad
pass=0; fail=0; failed=""
for t in $(cat $OUT/tests.txt); do
  if timeout 120 npm run -s "$t" > "$OUT/t-$t.log" 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); failed="$failed $t"; fi
done
echo "PASS=$pass FAIL=$fail failed:$failed" > $OUT/suites.txt
npx tsc --noEmit -p . > $OUT/tsc.log 2>&1; echo "tsc rc=$? errors=$(grep -c 'error TS' $OUT/tsc.log)" >> $OUT/suites.txt
echo DONE >> $OUT/suites.txt
