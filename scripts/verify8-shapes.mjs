// WHAT:       Verifier loop 8: NEW malformed HTML shapes (claim 1 re-derivation) shared by the Chromium recorder
//             (verify8-chromium-record.mjs) and the branch-vs-main-vs-Chromium probe (verify8-screen-probes.ts).
// WHY:        Loop 7 found 11/39 malformed shapes flipping Iris's live ask decision; b6b5f9af re-implemented
//             visibleHtml as "cut hidden text spans from the ORIGINAL html" + a quote-aware tag regex in htmlToText.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/qc-evidence/VERIFY-correspondence-proposals-8.md
// All data synthetic.
export const ASK = "Can you approve the budget?";
export const ATT = "On Monday the board wrote:";
const H = (s) => `<span style="display:none">${s}</span>`;

export const SHAPES = [
  // stray end tags
  ["stray-end-span", `Hello.</span>${ATT}</span><p>${ASK}</p>`],
  ["stray-end-b-i", `Hello.</b></i>${ASK}`],
  ["stray-end-table", `<p>Hello.</p></table><p>${ASK}</p>`],
  ["stray-end-body-html", `<p>Hello.</p></body></html><p>${ASK}</p>`],
  // unclosed tags
  ["unclosed-span-hidden-p-inside", `<span style="display:none">old<p>${ATT}<p>${ASK}`],
  ["unclosed-font-hidden-p", `<p><font style="display:none">old<p>${ATT}</font><p>${ASK}`],
  ["unclosed-a-hidden", `<p><a style="display:none" href="x">old<p>${ASK}</p>`],
  ["unclosed-div-hidden-eof", `<p>${ASK}</p><div style="display:none">old ${ATT}`],
  // <br> variants
  ["br-selfclose", `Hello<br/>${ATT}<br />${ASK}`],
  ["br-tab", `Hello<br\t>${ATT}<br\n>${ASK}`],
  ["br-upper-slash", `Hello<BR/>${ATT}<BR/ >${ASK}`],
  ["br-in-hidden", `Hello ${H(`x<br>${ATT}<br>`)}${ASK}`],
  // implied closes
  ["p-closed-by-ul", `<p>${ATT}<ul><li>${ASK}</ul>`],
  ["p-closed-by-hr", `<p>${ATT}<hr>${ASK}`],
  ["p-closed-by-pre", `<p>${ATT}<pre>${ASK}</pre>`],
  ["td-implied", `<table><tr><td style="display:none">${ATT}<td>${ASK}</table>`],
  // quoted '>' and quote oddities
  ["gt-in-dq-attr", `<p><a title="a>b">${ASK}</a></p>`],
  ["gt-in-sq-attr", `<p><img alt='x>y'>${ASK}</p>`],
  ["gt-in-dq-style", `<p style="font-family:'A>B'">${ASK}</p>`],
  ["apostrophe-unquoted-attr", `<p><b data-x=it's>${ASK} it's urgent</b></p>`],
  ["dq-inside-unquoted-attr", `<p><a href=foo"bar>Click</a> ${ASK} <b title="x">y</b></p>`],
  ["lone-dq-attr-name", `<p><span " class=x>${ASK}</span> ok</p>`],
  ["text-lt-letter-apostrophe", `<p>if a<b and it's fine, ${ASK} I'd say x>y</p>`],
  // hidden element spanning a <p> boundary
  ["hidden-span-across-p", `<p>Hello<span style="display:none">old<p>${ATT}</span></p><p>${ASK}</p>`],
  ["hidden-b-across-p", `<p>Hi<b style="display:none">x</p><p>${ATT}</b></p><p>${ASK}</p>`],
  // reconstructed formatting
  ["recon-b-display-none", `<b style="display:none"><p>${ATT}</b>${ASK}</p>`],
  ["recon-i-fontzero", `<i style="font-size:0"><div>${ATT}</i>${ASK}</div>`],
  ["recon-strong-table", `<p><strong style="display:none">old<table><tr><td>${ASK}</td></tr></table><p>${ATT}`],
  // comments and CDATA
  ["comment-att", `<!-- ${ATT} -->${ASK}`],
  ["comment-abrupt", `<!-->${ASK}<!-- x -->`],
  ["comment-bang-close", `<!-- a --!>${ASK}`],
  ["comment-empty", `<!---->${ASK}`],
  ["comment-with-reply-div", `<!-- <div id="divRplyFwdMsg"> -->${ASK}`],
  ["comment-with-script", `<!-- <script> -->${ASK}<script>x</script>`],
  ["comment-gt-inside", `<!-- a > b -->${ASK}`],
  ["comment-unterminated", `${ASK}<!-- trailing ${ATT}`],
  ["cond-comment-mso", `<!--[if mso]>${ATT}<![endif]-->${ASK}`],
  ["downlevel-revealed", `<![if !mso]>${ASK}<![endif]>`],
  ["cdata-in-body", `<![CDATA[${ATT}]]>${ASK}`],
  ["processing-instr", `<?xml version="1.0"?>${ASK}`],
  // entities inside hidden text
  ["entities-in-hidden", `${H("&lt;b&gt; On Monday&nbsp;the board wrote:")}${ASK}`],
  ["double-entity-hidden", `${H("&amp;lt;x&amp;gt;")}Price &amp;lt; 5. ${ASK}`],
  ["entity-split-hidden", `Q&${H("amp;x")}A. ${ASK}`],
  // hidden element whose text is an attribution
  ["hidden-attribution", `<div style="display:none">${ATT}</div><p>${ASK}</p>`],
  ["fontzero-attribution", `<div style="font-size:0">${ATT}</div><p>${ASK}</p>`],
  ["visible-att-then-hidden-ask", `<p>${ATT}</p>${H(ASK)}`],
  // CRLF / CR / NUL / astral
  ["crlf-hidden", `<p>Hello</p>\r\n<span style="display:none">\r\nold ${ATT}\r\n</span>\r\n<p>${ASK}</p>\r\n`],
  ["crlf-many-before-hidden", `${"<p>line</p>\r\n".repeat(40)}${H(ATT)}\r\n<p>${ASK}</p>`],
  ["cr-only-hidden", `<p>Hello</p>\r<span style="display:none">\rold ${ATT}\r</span>\r<p>${ASK}</p>`],
  ["nul-before-hidden", `<p>He\u0000llo</p>${H(ATT)}<p>${ASK}</p>`],
  ["astral-before-hidden", `<p>\u{1F600}\u{1F600} hi</p>${H(ATT)}<p>${ASK}</p>`],
  ["bom-start-hidden", `﻿<p>hi</p>${H(ATT)}<p>${ASK}</p>`],
  // raw-text elements
  ["script-unclosed", `<p>hi</p><script>var a=1;</p><p>${ASK}</p>`],
  ["style-unclosed", `<p>${ASK}</p><style>p{color:red}`],
  ["textarea-att", `<textarea>${ATT}</textarea><p>${ASK}</p>`],
  ["title-in-body", `<title>${ATT}</title><p>${ASK}</p>`],
  ["xmp-tags", `<xmp><b>${ATT}</b></xmp><p>${ASK}</p>`],
  // inherited visibility
  ["vis-hidden-then-visible", `<span style="visibility:hidden">${ATT}<span style="visibility:visible">${ASK}</span></span>`],
  ["hidden-attr-p", `<p hidden>${ATT}<p>${ASK}`],
  // depth
  ["deep-500-hidden-ancestor", `<div style="display:none">${"<div>".repeat(500)}${ATT}${"</div>".repeat(500)}</div><p>${ASK}</p>`],
  ["deep-500-visible-ask", `${"<div>".repeat(500)}${ASK}${"</div>".repeat(500)}`],
  // reply header inside hidden, Gmail realistic
  ["reply-div-hidden", `<p>${ASK}</p><div style="display:none" id="divRplyFwdMsg">x</div><p>tail</p>`],
  ["outlook-realistic", `<html><head><style><!-- p.MsoNormal{margin:0} --></style></head><body lang=EN-US><div class=WordSection1><p class=MsoNormal><span style='font-size:11.0pt;font-family:"Calibri",sans-serif'>${ASK}<o:p></o:p></span></p></div><div id="divRplyFwdMsg"><b>From:</b> x<br><b>Sent:</b> y</div><p>old?</p></body></html>`],
];
