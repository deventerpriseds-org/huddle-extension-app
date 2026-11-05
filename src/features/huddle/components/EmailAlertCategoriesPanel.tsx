// WHAT:       Settings -> Account -> "Email alerts": one toggle per KIND of automated mail (events,
//             building notices, bills, bookings, other automated) plus extra sender domains per kind.
//             Decides which of those Iris tells you about, and so which can land on the owed list.
// WHY:        Owner, 2026-11-05: newsletters and invoices were on his owed list, "though i think they
//             need toggles because the evite reminder was helpful because it was about a real person
//             or appointment". Categories + defaults live in lib/email/inbound-email.ts EMAIL_CATEGORIES.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:owed-digest
import { useCallback, useEffect, useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  getMyWorkflowConfigFn,
  setMyWorkflowConfigFn,
} from "../lib/identity/agent-workflow-config.functions";
import {
  EMAIL_CATEGORIES,
  resolveEmailCategoryPolicy,
  type EmailCategoryOverrides,
} from "../lib/email/inbound-email";

function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)),
    ),
  ];
}

export function EmailAlertCategoriesPanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () =>
      user
        ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
        : undefined,
    [user],
  );
  const [overrides, setOverrides] = useState<EmailCategoryOverrides>({});
  const [domainText, setDomainText] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  const syncText = (o: EmailCategoryOverrides) =>
    setDomainText(
      Object.fromEntries(EMAIL_CATEGORIES.map((c) => [c.id, (o[c.id]?.domains ?? []).join(", ")])),
    );

  useEffect(() => {
    if (!caller) return;
    void (async () => {
      try {
        const res = await getMyWorkflowConfigFn({ data: { caller } });
        const o = (res.config?.email_alert_categories ?? {}) as EmailCategoryOverrides;
        setOverrides(o);
        syncText(o);
      } catch {
        /* keep defaults */
      }
      setReady(true);
    })();
  }, [caller]);

  const persist = useCallback(
    async (next: EmailCategoryOverrides) => {
      if (!caller) return;
      setSaving(true);
      try {
        const res = await setMyWorkflowConfigFn({
          data: {
            caller,
            config: {
              email_alert_categories: next as Record<string, { on?: boolean; domains?: string[] }>,
            },
          },
        });
        if (res.error) toast.error(res.error);
        else if (res.config) {
          const o = (res.config.email_alert_categories ?? {}) as EmailCategoryOverrides;
          setOverrides(o);
          syncText(o);
        }
      } catch {
        toast.error("Couldn't save that setting.");
      } finally {
        setSaving(false);
      }
    },
    [caller],
  );

  const policy = resolveEmailCategoryPolicy(overrides);

  return (
    <div className="rounded-lg border p-4" data-testid="email-alert-categories">
      <h3 className="mb-1 text-sm font-semibold">Email alerts</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Iris always tells you about email from a real person that asks you something. These switches
        decide which kinds of automated mail she also tells you about — and so which can show up in
        your owed-replies list. Bulk marketing (anything with an unsubscribe header) stays filtered
        either way.
      </p>
      <div className="space-y-2">
        {EMAIL_CATEGORIES.map((c) => (
          <div key={c.id} className="rounded-md border border-hairline px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-sm">{c.label}</Label>
                <p className="text-[11px] text-muted-foreground">
                  {c.hint}
                  {c.defaultOn ? " On by default." : " Off by default."}
                </p>
              </div>
              <Switch
                checked={policy.on[c.id]}
                disabled={!ready || saving}
                onCheckedChange={(on) =>
                  void persist({ ...overrides, [c.id]: { ...overrides[c.id], on } })
                }
                data-testid={`email-cat-${c.id}`}
              />
            </div>
            {c.id !== "bills" && c.id !== "bookings" && c.id !== "service" ? (
              <div className="mt-2">
                <Input
                  className="h-7 text-xs"
                  placeholder={
                    c.domains.length
                      ? `Extra sender domains (built in: ${c.domains.slice(0, 3).join(", ")}…)`
                      : "Extra sender domains, comma separated"
                  }
                  value={domainText[c.id] ?? ""}
                  disabled={!ready || saving}
                  onChange={(e) => setDomainText((t) => ({ ...t, [c.id]: e.target.value }))}
                  onBlur={() => {
                    const domains = parseDomains(domainText[c.id] ?? "");
                    const prev = overrides[c.id]?.domains ?? [];
                    if (domains.join(",") === prev.join(",")) return;
                    void persist({ ...overrides, [c.id]: { ...overrides[c.id], domains } });
                  }}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
