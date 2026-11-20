# WHAT: builds the small Trinnex Library extraction fixtures (Test- prefixed, no real names or data).
# WHY:  AC-L1/L9/L11 tests need real pdf/docx/pptx/xlsx/vtt/srt bytes. Run: python3 -I make-fixtures.py <outdir>
# SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.  EVIDENCE: scripts/trinnex-library.test.ts
import os
import sys
import zipfile

out = sys.argv[1]


def z(name, parts, method=zipfile.ZIP_DEFLATED):
    with zipfile.ZipFile(os.path.join(out, name), "w", method) as f:
        for k, v in parts.items():
            f.writestr(k, v)


CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
z("Test-policy.docx", {
    "[Content_Types].xml": CT,
    "word/document.xml":
        f'<w:document {W}><w:body><w:p><w:r><w:t>Test-page one &amp; travel policy</w:t></w:r></w:p>'
        '<w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:t>paragraph</w:t></w:r></w:p>'
        '<w:p><w:r><w:br w:type="page"/><w:t>Test-page two text</w:t></w:r></w:p></w:body></w:document>',
})
A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'


def slide(t):
    return f'<p:sld {A}><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>'


z("Test-deck.pptx", {
    "[Content_Types].xml": CT,
    "ppt/presentation.xml": "<p:presentation/>",
    "ppt/slides/slide1.xml": slide("Test-slide one"),
    "ppt/slides/slide2.xml": slide("Test-slide two"),
    "ppt/slides/slide10.xml": slide("Test-slide ten"),
}, zipfile.ZIP_STORED)
z("Test-budget.xlsx", {
    "[Content_Types].xml": CT,
    "xl/workbook.xml": '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><t>Item</t></si><si><t>Test-travel</t></si></sst>',
    "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>'
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1200</v></c></row></sheetData></worksheet>',
})
z("Test-fake.pdf", {"a.txt": "not a pdf"})  # a ".pdf" that is really a zip (AC-L1)
with open(os.path.join(out, "Test-protected.docx"), "wb") as f:  # encrypted Office files are OLE containers
    f.write(bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"\0" * 504)
with open(os.path.join(out, "Test-empty.txt"), "wb") as f:
    f.write(b"   \n")
with open(os.path.join(out, "Test-call.vtt"), "w") as f:
    f.write(
        "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Speaker 1>Test-hello from one\n\n"
        "00:00:04.000 --> 00:00:06.000\n<v Speaker 1>still one\n\n"
        "00:01:05.200 --> 00:01:07.000\n<v Speaker 10>Test-ten speaks\n\n"
        "00:01:08.000 --> 00:01:09.000\nno label line\n"
    )
with open(os.path.join(out, "Test-call.srt"), "w") as f:
    f.write(
        "1\n00:00:01,000 --> 00:00:02,000\nVon Ellis: Test-opening line\n\n"
        "2\n00:00:03,500 --> 00:00:05,000\nSpeaker 2: Test-reply\n"
    )


def pdf(pages):
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for t in pages:
        s = f"BT /F1 12 Tf 72 720 Td ({t}) Tj ET" if t else ""
        objs.append(f"<< /Length {len(s)} >>\nstream\n{s}\nendstream")
        objs.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>"
        )
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    b = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objs):
        offs.append(len(b))
        b += f"{i + 1} 0 obj\n{o}\nendobj\n".encode()
    x = len(b)
    b += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offs:
        b += f"{o:010d} 00000 n \n".encode()
    b += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    return b


with open(os.path.join(out, "Test-two-pages.pdf"), "wb") as f:
    f.write(pdf(["Test-first page words", "Test-second page words"]))
with open(os.path.join(out, "Test-image-only.pdf"), "wb") as f:
    f.write(pdf([""]))
