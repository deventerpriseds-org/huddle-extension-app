#!/usr/bin/env bash
# Waits until both dry-run workflow runs are completed; prints status + conclusion.
TOK="${GH_TOKEN:-$GITHUB_TOKEN}"
for i in $(seq 1 80); do
  done_all=1
  line=""
  for id in 43797806975; do
    s=$(curl -s -H "Authorization: Bearer $TOK" "https://api.github.com/repos/deventerpriseds-org/huddle-extension-app/actions/runs/$id" | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r.get("status"),r.get("conclusion"))')
    line="$line $id=$s"
    case "$s" in completed*) ;; *) done_all=0 ;; esac
  done
  if [ $done_all = 1 ]; then echo "$line"; exit 0; fi
  sleep 15
done
echo "timeout:$line"
