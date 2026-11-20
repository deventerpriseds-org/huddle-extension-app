/*
WHAT:       SAMPLE data shared by the three Trinnex prototype pages, so the meeting you retitle in
            Meetings is the same meeting the Library lists and Iris cites in Ask. Every person,
            meeting and policy below is an invented EXAMPLE, not the owner's real data.
WHY:        A prototype opens in a realistic working state; one data file keeps three parallel pages
            consistent.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   field names mirror chat.fireflies_meetings (id, title, meeting_at) and Fireflies'
            meeting_attendees / summary.action_items as read by lib/fireflies/fireflies.server.ts.
*/
window.TRINNEX_SAMPLE = {
  owner: "Von",
  // The assignee lookup. "Von" is pinned and can never be removed; names added in triage join it.
  people: ["Von", "Michael R.", "Priya S.", "Dana K."],
  meetings: [
    {
      id: "ff-01JD8Q",
      firefliesTitle: "Weekly sync",
      title: "Weekly sync",
      meetingAt: "2026-11-18T14:00:00-05:00",
      durationMin: 47,
      onedriveFile: "fireflies-01JD8Q.md",
      attendees: ["Von", "Michael R.", "Priya S.", "Dana K."],
      participants: [],
      series: "",
      summary: "Q1 roadmap sign-off is held until the data-platform estimate is in. Michael confirmed the outcome of the vendor review: keep the current vendor for one more year with a 90-day exit clause. Hiring for two senior engineers moves to January.",
      actionItems: [
        { text: "Send the data-platform estimate to the leadership group", stamp: "12:40", assignee: null },
        { text: "Draft the 90-day exit clause language for the vendor renewal", stamp: "21:05", assignee: null },
        { text: "Post the two senior engineer roles in January", stamp: "33:10", assignee: null },
        { text: "Book the Q1 planning offsite", stamp: "41:52", assignee: null }
      ],
      triaged: false
    },
    {
      id: "ff-01JD3K",
      firefliesTitle: "Meeting with Priya",
      title: "Meeting with Priya",
      meetingAt: "2026-11-14T10:30:00-05:00",
      durationMin: 28,
      onedriveFile: "fireflies-01JD3K.md",
      attendees: ["Von", "Priya S."],
      participants: [],
      series: "",
      summary: "Reviewed the travel booking change: business-card points on company travel stay with the company and are not personal rewards. Priya will share the updated policy PDF.",
      actionItems: [
        { text: "Share the updated travel and expense policy PDF", stamp: "08:15", assignee: null },
        { text: "Update the team onboarding page with the points rule", stamp: "19:30", assignee: null }
      ],
      triaged: false
    },
    {
      id: "ff-01JCZ1",
      firefliesTitle: "Engineering Leaders",
      title: "Engineering Leaders weekly",
      meetingAt: "2026-11-11T14:00:00-05:00",
      durationMin: 52,
      onedriveFile: "2026-11-11 Engineering Leaders weekly - Michael R., Priya S., Dana K..md",
      attendees: ["Von", "Michael R.", "Priya S.", "Dana K."],
      participants: ["Michael R.", "Priya S.", "Dana K."],
      series: "Engineering Leaders",
      summary: "Incident review process agreed. Michael owns the on-call rotation redesign.",
      actionItems: [
        { text: "Redesign the on-call rotation", stamp: "15:02", assignee: "Michael R." },
        { text: "Write up the incident review template", stamp: "27:44", assignee: "Von" }
      ],
      triaged: true
    }
  ],
  library: [
    { id: "doc-1", name: "Travel and Expense Policy 2026.pdf", kind: "Document", category: "Travel and expenses", addedAt: "2026-11-15", pages: 14, chunks: 38, facts: 61, status: "Searchable", tags: ["travel", "expenses", "credit card"] },
    { id: "doc-2", name: "Engineering Leaders weekly 2026-11-11 (Fireflies)", kind: "Transcript", category: "Leadership meetings", addedAt: "2026-11-11", pages: null, chunks: 44, facts: 23, status: "Searchable", tags: ["Engineering Leaders"], participants: ["Michael R.", "Priya S.", "Dana K."] },
    { id: "doc-3", name: "Weekly sync 2026-11-18 (Fireflies)", kind: "Transcript", category: "Leadership meetings", addedAt: "2026-11-18", pages: null, chunks: 0, facts: 0, status: "Waiting for triage", tags: [], participants: [] },
    { id: "doc-4", name: "Vendor review deck.pptx", kind: "Document", category: "Vendors", addedAt: "2026-11-17", pages: 22, chunks: 31, facts: 17, status: "Searchable", tags: ["vendor"] }
  ],
  // Categories are DYNAMIC: this list is only what the sample library already uses. A category typed
  // (or accepted from Iris's suggestion) on upload joins it, the same way new names join `people`.
  categories: ["Travel and expenses", "Leadership meetings", "Vendors"],
  // Answers the Ask page shows; each cites where it came from.
  qa: [
    {
      q: "What did Michael say was the outcome of the vendor review?",
      a: "Michael said the outcome was to keep the current vendor for one more year, with a 90-day exit clause added to the renewal.",
      sources: [
        { title: "Weekly sync", date: "2026-11-18", speaker: "Michael R.", at: "20:12", kind: "Transcript", quote: "So the outcome is we stay with them one more year, but we put a 90-day exit in the renewal." },
        { title: "Vendor review deck.pptx", date: "2026-11-17", speaker: null, at: "slide 19", kind: "Document", quote: "Recommendation: renew 12 months; add termination for convenience (90 days)." }
      ],
      facts: [["Vendor review", "outcome", "renew 1 year with 90-day exit clause"], ["Michael R.", "stated", "vendor review outcome"]]
    },
    {
      q: "What did we discuss as to-dos in the last Engineering Leaders meeting?",
      a: "In the Engineering Leaders weekly on Nov 11 there were two to-dos: Michael owns redesigning the on-call rotation, and you own writing up the incident review template.",
      sources: [
        { title: "Engineering Leaders weekly", date: "2026-11-11", speaker: null, at: "action items", kind: "Transcript", quote: "Redesign the on-call rotation (Michael R.) · Write up the incident review template (Von)" }
      ],
      facts: [["On-call rotation redesign", "owner", "Michael R."], ["Incident review template", "owner", "Von"]]
    },
    {
      q: "What is the company policy for travel points on business credit cards?",
      a: "Points earned on the company card for business travel belong to the company and are not personal rewards. They are pooled for future business travel.",
      sources: [
        { title: "Travel and Expense Policy 2026.pdf", date: "2026-11-15", speaker: null, at: "page 9, section 4.3", kind: "Document", quote: "Rewards points accrued on corporate cards for business expenses are company property and may only be redeemed for business travel." },
        { title: "Meeting with Priya", date: "2026-11-14", speaker: "Priya S.", at: "06:48", kind: "Transcript", quote: "Points on company travel stay with the company, they're not personal rewards." }
      ],
      facts: [["Corporate card points", "belong to", "company"], ["Corporate card points", "redeemable for", "business travel only"]]
    }
  ]
};
