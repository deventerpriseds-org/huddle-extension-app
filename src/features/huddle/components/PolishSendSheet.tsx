// WHAT:       Polish's "Send" sheet — where finished copy goes: Copy (plain), Copy formatted (keeps
//             paragraphs + bullets when pasted into Word / Outlook), an email DRAFT in a chosen mailbox,
//             or a Word document (saved to Files, copied to OneDrive, and downloadable for Google Drive).
// WHY:        Owner (2026-11-05): "push draft with options to go to my email inbox for a select account
//             or a word document in onedrive/google drive or a fast copy/paste block so i can drop it in."
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   reuses createGraphDraft (graph-email.server) and createArtifact + mirrorArtifactToOneDrive
//             (artifacts.server) via lib/polish/polish.functions.ts; helpers tested in scripts/polish-core.test.ts
//
// Nothing here SENDS email: it only creates a draft you open and send yourself.

import { useEffect, useState } from "react";
import { ClipboardCopy, Download, ExternalLink, FileText, Mail, Type } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { polishedToHtml, splitSubject, suggestFileName } from "../lib/polish/polish-core";
import {
  polishDestinationsFn,
  polishEmailDraftFn,
  polishWordDocFn,
} from "../lib/polish/polish.functions";

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;

const LS_FROM = "huddle:polish:from";
const LS_OD = "huddle:polish:onedrive";
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* per-device convenience only */
  }
};

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-surface p-3.5">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          {icon}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

const inputCls =
  "min-h-10 w-full rounded-lg border border-input bg-surface-2 px-3 text-sm outline-none focus:border-ring";
const primaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:opacity-50";
const ghostBtn =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-input bg-surface px-3 text-[13px] font-medium disabled:opacity-50";

export function PolishSendSheet({
  open,
  onOpenChange,
  text,
  caller,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  text: string;
  caller: Caller;
  onCopy: () => void;
}) {
  const [mailboxes, setMailboxes] = useState<string[]>([]);
  const [from, setFrom] = useState<string>(() => lsGet(LS_FROM) ?? "");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [fileName, setFileName] = useState("");
  const [onedrive, setOnedrive] = useState<boolean>(() => lsGet(LS_OD) !== "0");
  const [busy, setBusy] = useState<null | "mail" | "word">(null);
  const [mailResult, setMailResult] = useState<{ ok: boolean; msg: string; link?: string } | null>(
    null,
  );
  const [wordResult, setWordResult] = useState<{ ok: boolean; msg: string; link?: string } | null>(
    null,
  );

  // Prefill from the current text each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setSubject(splitSubject(text).subject || suggestFileName(text));
    setFileName(suggestFileName(text));
    setMailResult(null);
    setWordResult(null);
  }, [open, text]);

  useEffect(() => {
    if (!open || mailboxes.length || !caller) return;
    polishDestinationsFn({ data: { caller } })
      .then((d) => {
        setMailboxes(d.mailboxes);
        setFrom((f) => (f && d.mailboxes.includes(f) ? f : (d.mailboxes[0] ?? "")));
      })
      .catch(() => setMailboxes([]));
  }, [open, caller, mailboxes.length]);

  const copyFormatted = async () => {
    try {
      const html = polishedToHtml(text);
      // ClipboardItem keeps bullets/paragraphs in Word and Outlook; plain text rides along for everything else.
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      toast.success("Copied with formatting.");
    } catch {
      onCopy(); // older browsers / app views: fall back to plain copy
    }
  };

  const makeDraft = async () => {
    if (!caller || !from || !subject.trim()) return;
    setBusy("mail");
    setMailResult(null);
    lsSet(LS_FROM, from);
    try {
      const body = splitSubject(text).subject ? splitSubject(text).body : text;
      const r = await polishEmailDraftFn({
        data: { caller, from, to, subject: subject.trim(), text: body },
      });
      setMailResult(
        r.ok
          ? { ok: true, msg: `Draft saved in ${r.from}'s Drafts folder.`, link: r.webLink }
          : { ok: false, msg: r.error ?? "Couldn't create the draft." },
      );
    } catch {
      setMailResult({ ok: false, msg: "Couldn't reach Huddle. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const makeWord = async (download: boolean) => {
    if (!caller || !fileName.trim()) return;
    setBusy("word");
    setWordResult(null);
    lsSet(LS_OD, onedrive ? "1" : "0");
    try {
      const r = await polishWordDocFn({
        data: { caller, name: fileName.trim(), text, onedrive: onedrive && !download },
      });
      if (!r.ok) {
        setWordResult({ ok: false, msg: r.error ?? "Couldn't make the document." });
        return;
      }
      if (download && r.docxBase64) {
        const bin = Uint8Array.from(atob(r.docxBase64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(
          new Blob([bin], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = r.fileName ?? "Polished draft.docx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      const parts: string[] = [];
      if (r.artifactId) parts.push("Saved to Files › Polish.");
      if (download) parts.push(`Downloaded ${r.fileName}.`);
      else if (onedrive && r.onedriveUrl)
        parts.push("Copied to OneDrive › Huddle Artifacts › Polish.");
      else if (onedrive && r.onedriveError)
        parts.push(
          r.needsConsent
            ? "OneDrive isn't permitted yet (admin consent needed)."
            : `OneDrive failed: ${r.onedriveError}`,
        );
      setWordResult({
        ok: !(onedrive && !download && r.onedriveError),
        msg: parts.join(" "),
        link: r.onedriveUrl ?? undefined,
      });
    } catch {
      setWordResult({ ok: false, msg: "Couldn't reach Huddle. Try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        <div className="border-b border-hairline px-5 py-4 pr-12">
          <SheetTitle className="text-base">Send</SheetTitle>
          <SheetDescription className="text-xs">
            Copy it, start an email draft, or save it as a Word document.
          </SheetDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-background px-4 pb-6 pt-4">
          <Section icon={<ClipboardCopy size={15} />} title="Copy and paste">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={ghostBtn} onClick={onCopy}>
                <Type size={14} /> Copy text
              </button>
              <button type="button" className={ghostBtn} onClick={copyFormatted}>
                <ClipboardCopy size={14} /> Copy formatted
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Formatted keeps paragraphs and bullets when you paste into Word or Outlook.
            </p>
          </Section>

          <Section icon={<Mail size={15} />} title="Email draft">
            <label htmlFor="polish-from" className="text-xs font-medium text-muted-foreground">
              Account
            </label>
            <select
              id="polish-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={inputCls}
              disabled={!mailboxes.length}
            >
              {!mailboxes.length && <option value="">Loading accounts…</option>}
              {mailboxes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label htmlFor="polish-to" className="text-xs font-medium text-muted-foreground">
              To (optional)
            </label>
            <input
              id="polish-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="name@company.com, another@company.com"
              inputMode="email"
              autoComplete="off"
              className={inputCls}
            />
            <label htmlFor="polish-subject" className="text-xs font-medium text-muted-foreground">
              Subject
            </label>
            <input
              id="polish-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={inputCls}
            />
            <button
              type="button"
              className={primaryBtn}
              onClick={makeDraft}
              disabled={busy !== null || !from || !subject.trim()}
            >
              <Mail size={14} /> {busy === "mail" ? "Creating draft…" : "Create draft"}
            </button>
            <p className="text-xs text-muted-foreground">
              Nothing is sent. The draft waits in that account's Drafts folder for you.
            </p>
            {mailResult && <Result {...mailResult} linkLabel="Open draft in Outlook" />}
          </Section>

          <Section icon={<FileText size={15} />} title="Word document">
            <label htmlFor="polish-filename" className="text-xs font-medium text-muted-foreground">
              File name
            </label>
            <input
              id="polish-filename"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className={inputCls}
            />
            <label className="flex min-h-9 items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={onedrive}
                onChange={(e) => setOnedrive(e.target.checked)}
                className="size-4 accent-[var(--primary)]"
              />
              Also copy to OneDrive
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={primaryBtn}
                onClick={() => makeWord(false)}
                disabled={busy !== null || !fileName.trim()}
              >
                <FileText size={14} /> {busy === "word" ? "Saving…" : "Save document"}
              </button>
              <button
                type="button"
                className={ghostBtn}
                onClick={() => makeWord(true)}
                disabled={busy !== null || !fileName.trim()}
              >
                <Download size={14} /> Download .docx
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Saved documents appear in Files under Polish. Google Drive isn't connected to Huddle
              yet: download the .docx and drop it into Drive.
            </p>
            {wordResult && <Result {...wordResult} linkLabel="Open in OneDrive" />}
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Result({
  ok,
  msg,
  link,
  linkLabel,
}: {
  ok: boolean;
  msg: string;
  link?: string;
  linkLabel: string;
}) {
  return (
    <div role="status" className={ok ? "text-[13px] text-success" : "text-[13px] text-destructive"}>
      {msg}
      {link && (
        <>
          {" "}
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
          >
            {linkLabel} <ExternalLink size={12} />
          </a>
        </>
      )}
    </div>
  );
}
