import json, sys
r = json.load(open(sys.argv[1]))
for x in r['results']:
    d = x.get('detail') or ''
    if x['name'].startswith('DUMP'):
        dd = json.loads(d)
        tops = dd['topics']
        nonempty = [f"{t['n']}={t['t']}{'' if str(t['t']) == (t['c'] or '0') else '(badge ' + repr(t['c']) + ')'}" for t in tops if t['t'] or t['c']]
        print(('PASS ' if x['pass'] else 'FAIL ') + x['name'], f"topics={len(tops)} direct={dd['direct']}")
        print('     nonzero:', ' | '.join(nonempty))
    else:
        print(('PASS ' if x['pass'] else 'FAIL ') + x['name'], '--', d[:900])
print('failedRequests', r.get('failedRequests'))
