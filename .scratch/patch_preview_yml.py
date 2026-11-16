import sys
root = sys.argv[1]
p = root + "/.github/workflows/proposals-preview.yml"
s = open(p).read()
b = open(root + "/.github/workflows/correspondence-backfill.yml").read()
block = b[b.index("      - name: Azure login"):b.index("      - name: Back-fill the ledger")]
cond = "        if: ${{ env.READS_LEDGER == '1' }}\n"
out = []
for chunk in block.split("      - name: ")[1:]:
    name, rest = chunk.split("\n", 1)
    out.append("      - name: " + name + "\n" + cond + rest)
block = "".join(out)
anchor = "      - run: npm ci --no-audit --no-fund\n"
assert s.count(anchor) == 1
s = s.replace(anchor, anchor + block)
# cleanup step at the end
s = s.rstrip("\n") + "\n" + (
    "      - name: Remove the runner firewall rule\n"
    "        if: always() && env.READS_LEDGER == '1' && env.FW_RULE != ''\n"
    "        run: |\n"
    "          az postgres flexible-server firewall-rule delete -g \"$PG_RG\" -s \"$PG_SRV\" \\\n"
    "            --rule-name \"$FW_RULE\" --yes --only-show-errors >/dev/null 2>&1 && echo \"Removed $FW_RULE.\" || echo \"Cleanup skipped.\"\n"
)
open(p, "w").write(s)
print("ok")
