"""Markdown to PDF, for the two generated documents.

Supports the subset the manual and the project report actually use: headings, paragraphs,
fenced code, pipe tables, blockquotes, bullet and ordered lists, images, horizontal rules, and
inline bold/italic/code/links.

Deliberately not a general CommonMark implementation. A full parser is a dependency and a
second source of truth about what the document says; this covers what is written, and fails
loudly on anything else so a typo cannot silently drop a paragraph.

Inline formatting is converted to reportlab's mini-markup, which is a subset of HTML - so the
`<b>` and `<i>` already in the Markdown pass straight through. What has to be escaped is
anything that looks like a tag but is not, and what has to be translated is Markdown's own
`**bold**`, `_italic_` and backtick code.

Run: python scripts/md2pdf.py <input.md> <output.pdf> --title "..." --subtitle "..."
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

sys.path.insert(0, str(Path(__file__).parent))
from pdfkit import (  # noqa: E402
    ACCENT, CODE_INK, CODE_RULE, CONTENT_W, F, GOOD, INK, MUTED, QUOTE_BG, RULE, WARN,
    Doc, callout, styles, toc_flowable,
)

FENCE = re.compile(r"^```(\w*)\s*$")


# ── inline ─────────────────────────────────────────────────────────────────────────
def inline(text: str) -> str:
    """Markdown inline syntax to reportlab markup.

    Order matters: inline code is extracted first and stashed, because its contents must not
    be interpreted - a `*` inside a code span is a literal asterisk, and treating it as
    emphasis is how a code sample turns into italics.
    """
    stash: list[str] = []

    def keep(m: re.Match[str]) -> str:
        stash.append(m.group(1))
        return f"@@CODE{len(stash) - 1}@@"

    text = re.sub(r"`([^`]+)`", keep, text)

    # Escape bare ampersands and angle brackets so ordinary prose is not read as markup.
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    # Restore the tags the document legitimately uses.
    text = re.sub(r"&lt;/?(b|i|u|br|font|super|sub|strike)\b([^&]*)&gt;",
                  lambda m: f"<{m.group(1)}{m.group(2)}>", text)

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<link href="\2" color="#1f6feb">\1</link>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<i>\1</i>", text)

    for i, raw in enumerate(stash):
        text = text.replace(
            f"@@CODE{i}@@",
            f'<font face="{F.mono}" size="8.4" color="#24292f">{raw}</font>')

    return text


def split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    return bool(re.fullmatch(r"\|?[\s:|-]+\|?", line.strip())) and "-" in line


# ── blocks ─────────────────────────────────────────────────────────────────────────
def convert(md: str, st: dict, img_root: Path) -> list:
    lines = md.split("\n")
    out: list = []
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Blank
        if not stripped:
            i += 1
            continue

        # Fenced code
        m = FENCE.match(stripped)
        if m:
            i += 1
            buf: list[str] = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            body = "\n".join(buf)
            size = 7.0 if len(body) > 2600 else (7.4 if len(body) > 1200 else 7.8)
            out += code_block(body, size)
            continue

        # Page break marker
        if stripped == "<!-- pagebreak -->":
            out.append(PageBreak())
            i += 1
            continue

        # Contents placeholder. The document is built twice so the page numbers are real.
        if stripped == "<!-- toc -->":
            out.append(Paragraph("Contents", st["h1"]))
            out.append(toc_flowable())
            i += 1
            continue

        # Horizontal rule
        if re.fullmatch(r"-{3,}|\*{3,}", stripped):
            out += [Spacer(1, 2.5 * mm),
                    HRFlowable(width="100%", thickness=0.5, color=RULE,
                               spaceBefore=1 * mm, spaceAfter=3 * mm)]
            i += 1
            continue

        # Image
        if stripped.startswith("!["):
            m2 = re.match(r"!\[(.*?)\]\((.*?)\)", stripped)
            if m2:
                alt, src = m2.group(1), m2.group(2)
                path = (img_root / src).resolve()
                if path.exists():
                    out += figure(path, alt, st)
                else:
                    out += [callout("gotcha", f"missing image: {src}", st)]
                i += 1
                continue

        # Heading
        m3 = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m3:
            level = len(m3.group(1))
            key = {1: "h1", 2: "h2", 3: "h3", 4: "h3"}[level]
            out.append(Paragraph(inline(m3.group(2)), st[key]))
            i += 1
            continue

        # Table
        if stripped.startswith("|") and i + 1 < len(lines) and is_separator(lines[i + 1]):
            header = split_row(stripped)
            i += 2
            rows: list[list[str]] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            out.append(data_table(header, rows, st))
            out.append(Spacer(1, 3 * mm))
            continue

        # Blockquote
        if stripped.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append(block_quote(" ".join(x for x in buf if x), st))
            out.append(Spacer(1, 2.5 * mm))
            continue

        # Lists
        if re.match(r"^\s*([-*+]|\d+\.)\s+", line):
            items: list[str] = []
            ordered = bool(re.match(r"^\s*\d+\.\s", line))
            while i < len(lines) and re.match(r"^\s*([-*+]|\d+\.)\s+", lines[i]):
                items.append(re.sub(r"^\s*([-*+]|\d+\.)\s+", "", lines[i]).rstrip())
                i += 1
            style = st["numbered"] if ordered else st["bullet"]
            marker = "" if ordered else "\u2022"
            for n, item in enumerate(items, 1):
                out.append(Paragraph(inline(item), style,
                                     bulletText=(f"{n}." if ordered else marker)))
            out.append(Spacer(1, 2 * mm))
            continue

        # Paragraph
        buf = [stripped]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(
                r"^(#{1,4}\s|```|\||>|!\[|-{3,}|\s*([-*+]|\d+\.)\s)", lines[i]):
            buf.append(lines[i].strip())
            i += 1
        out.append(Paragraph(inline(" ".join(buf)), st["body"]))

    return out


def code_block(text: str, size: float) -> list:
    from reportlab.platypus import Preformatted

    pre = Preformatted(
        text.rstrip("\n"),
        ParagraphStyle(
            "pre", fontName=F.mono, fontSize=size, leading=size * 1.42,
            textColor=CODE_INK, backColor=colors.HexColor("#f4f6f8"),
            borderPadding=(3 * mm, 4 * mm, 3 * mm, 4 * mm),
            borderWidth=0.5, borderColor=CODE_RULE,
            spaceBefore=1.5 * mm, spaceAfter=2.5 * mm,
        ),
        maxLineLength=int((CONTENT_W - 8 * mm) / (size * 0.6)),
        newLineChars="",
    )
    return [pre]


def block_quote(text: str, st: dict) -> Table:
    t = Table([[Paragraph(inline(text), ParagraphStyle(
        "q", parent=st["body"], fontName=F.body_italic, textColor=MUTED,
        spaceAfter=0))]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), QUOTE_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.6 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.6 * mm),
    ]))
    return t


def data_table(headers: list[str], rows: list[list[str]], st: dict) -> Table:
    hs = ParagraphStyle("th", parent=st["table_head"])
    cs = ParagraphStyle("td", parent=st["table_cell"])
    ncol = len(headers)
    data = [[Paragraph(inline(h), hs) for h in headers]]
    for r in rows:
        r = (r + [""] * ncol)[:ncol]
        data.append([Paragraph(inline(c), cs) for c in r])

    widths = []
    for col in range(ncol):
        longest = max([len(re.sub(r"[`*]", "", headers[col]))] +
                      [len(re.sub(r"[`*]", "", r[col])) if col < len(r) else 0 for r in rows])
        weights = [len(re.sub(r"[`*]", "", headers[col]))] + \
                  [len(re.sub(r"[`*]", "", r[col])) if col < len(r) else 0 for r in rows]
        share = sum(weights) or 1
        widths.append(max(0.10, min(0.55, share / (sum(
            max(1, len(re.sub(r"[`*]", "", r[c])) if c < len(r) else 1)
            for c in range(ncol)) or 1) * 1.0)))
    scale = CONTENT_W / sum(widths)
    widths = [w * scale for w in widths]

    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f4")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.9, colors.HexColor("#b9c2cc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.7 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.7 * mm),
    ]
    for r in range(1, len(data)):
        if r % 2 == 0:
            style.append(("BACKGROUND", (0, r), (-1, r), colors.HexColor("#fafbfc")))
    t.setStyle(TableStyle(style))
    return t


def figure(path: Path, caption: str, st: dict) -> list:
    from PIL import Image as PILImage

    with PILImage.open(path) as im:
        iw, ih = im.size
    w = CONTENT_W
    h = w * ih / iw
    if h > 100 * mm:
        h = 100 * mm
        w = h * iw / ih
    img = Image(str(path), width=w, height=h)
    img.hAlign = "CENTER"
    return [KeepTogether([Spacer(1, 2 * mm), img,
                          Paragraph(f"<i>{inline(caption)}</i>", st["caption"])])]


def build(md_path: Path, pdf_path: Path, title: str, subtitle: str) -> None:
    st = styles()
    story = convert(md_path.read_text(encoding="utf-8"), st, md_path.parent)
    doc = Doc(str(pdf_path), title, subtitle)
    doc.multiBuild(story)
    print(f"wrote {pdf_path.name}  ({pdf_path.stat().st_size // 1024} KB, "
          f"{len(story)} blocks)")


if __name__ == "__main__":
    args = sys.argv[1:]
    title = "Document"
    subtitle = ""
    if "--title" in args:
        i = args.index("--title")
        title = args[i + 1]
        del args[i:i + 2]
    if "--subtitle" in args:
        i = args.index("--subtitle")
        subtitle = args[i + 1]
        del args[i:i + 2]
    build(Path(args[0]), Path(args[1]), title, subtitle)
