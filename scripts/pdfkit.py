"""Shared PDF toolkit for both documents.

reportlab only, because it is installed, pure-Python, and produces a real vector PDF with
selectable text - which matters for a document full of code, where a screenshot of code is
worse than useless.

Deliberately not: markdown->HTML->browser->PDF. That needs a headless browser download, disk is
short, and it makes the build depend on a network fetch for something reportlab does natively.

Palette and spacing are defined once here so both documents look like one set.
"""

from __future__ import annotations

from dataclasses import dataclass

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)

# ── Palette ────────────────────────────────────────────────────────────────────────
# Dark ink on warm paper. Chosen over pure black/white because long technical prose in
# #000 on #fff is genuinely harder to read, and this document is long technical prose.
INK = colors.HexColor("#1a1c1f")
MUTED = colors.HexColor("#5c6570")
FAINT = colors.HexColor("#8b95a1")
RULE = colors.HexColor("#d8dde3")
ACCENT = colors.HexColor("#1f6feb")       # links, emphasis
ACCENT_DARK = colors.HexColor("#0b4bb8")
GOOD = colors.HexColor("#1a7f4b")
WARN = colors.HexColor("#a15c00")
BAD = colors.HexColor("#b3261e")
CODE_BG = colors.HexColor("#f4f6f8")
CODE_INK = colors.HexColor("#24292f")
CODE_RULE = colors.HexColor("#dfe3e8")
QUOTE_BG = colors.HexColor("#f0f6fc")

PAGE = A4
MARGIN_X = 20 * mm
MARGIN_TOP = 18 * mm
MARGIN_BOTTOM = 16 * mm
CONTENT_W = PAGE[0] - 2 * MARGIN_X


@dataclass(frozen=True)
class Fonts:
    """One place to change every typeface."""

    body: str = "Helvetica"
    body_bold: str = "Helvetica-Bold"
    body_italic: str = "Helvetica-Oblique"
    mono: str = "Courier"
    mono_bold: str = "Courier-Bold"


F = Fonts()


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    s: dict[str, ParagraphStyle] = {}

    s["title"] = ParagraphStyle(
        "title", parent=base["Title"], fontName=F.body_bold, fontSize=27, leading=32,
        textColor=INK, alignment=TA_LEFT, spaceAfter=2 * mm,
    )
    s["subtitle"] = ParagraphStyle(
        "subtitle", parent=base["Normal"], fontName=F.body, fontSize=12.5, leading=17,
        textColor=MUTED, spaceAfter=6 * mm,
    )
    s["h1"] = ParagraphStyle(
        "h1", parent=base["Heading1"], fontName=F.body_bold, fontSize=17, leading=21,
        textColor=INK, spaceBefore=9 * mm, spaceAfter=3.5 * mm,
    )
    s["h2"] = ParagraphStyle(
        "h2", parent=base["Heading2"], fontName=F.body_bold, fontSize=13, leading=17,
        textColor=INK, spaceBefore=6 * mm, spaceAfter=2.5 * mm,
    )
    s["h3"] = ParagraphStyle(
        "h3", parent=base["Heading3"], fontName=F.body_bold, fontSize=11, leading=15,
        textColor=ACCENT_DARK, spaceBefore=4.5 * mm, spaceAfter=2 * mm,
    )
    s["body"] = ParagraphStyle(
        "body", parent=base["BodyText"], fontName=F.body, fontSize=9.7, leading=14.2,
        textColor=INK, alignment=TA_LEFT, spaceAfter=2.6 * mm,
    )
    s["bullet"] = ParagraphStyle(
        "bullet", parent=s["body"], leftIndent=5 * mm, bulletIndent=1.5 * mm,
        spaceAfter=1.4 * mm,
    )
    s["numbered"] = ParagraphStyle(
        "numbered", parent=s["body"], leftIndent=7 * mm, bulletIndent=1.5 * mm,
        spaceAfter=1.6 * mm,
    )
    s["caption"] = ParagraphStyle(
        "caption", parent=s["body"], fontName=F.body_italic, fontSize=8.6, leading=11.5,
        textColor=MUTED, spaceBefore=1.2 * mm, spaceAfter=4 * mm,
    )
    s["table_head"] = ParagraphStyle(
        "table_head", parent=s["body"], fontName=F.body_bold, fontSize=8.6, leading=11.5,
        textColor=INK, spaceAfter=0,
    )
    s["table_cell"] = ParagraphStyle(
        "table_cell", parent=s["body"], fontSize=8.4, leading=11.2, spaceAfter=0,
    )
    s["toc1"] = ParagraphStyle(
        "toc1", parent=s["body"], fontSize=10, leading=15, leftIndent=0,
        spaceAfter=0.6 * mm,
    )
    s["toc2"] = ParagraphStyle(
        "toc2", parent=s["body"], fontSize=9, leading=13, leftIndent=6 * mm,
        textColor=MUTED, spaceAfter=0.4 * mm,
    )
    return s


class Doc(BaseDocTemplate):
    """Page template with a running header, a footer, and a printed URL on page 1.

    The footer deliberately does NOT say "page N of M" on page one, because a cover page
    numbered "1 of 60" reads like a bug.
    """

    def __init__(self, path: str, title: str, subtitle: str, after_toc=True, **kw):
        self.doc_title = title
        self.doc_subtitle = subtitle
        self.after_toc = after_toc
        super().__init__(
            path, pagesize=PAGE,
            leftMargin=MARGIN_X, rightMargin=MARGIN_X,
            topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
            title=title, author="collab-editor",
            subject=subtitle, **kw,
        )
        frame = Frame(
            MARGIN_X, MARGIN_BOTTOM, CONTENT_W,
            PAGE[1] - MARGIN_TOP - MARGIN_BOTTOM, id="body",
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        )
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[frame], onPage=self._cover_page),
            PageTemplate(id="normal", frames=[frame], onPage=self._normal_page),
        ])

    def afterFlowable(self, flowable):
        """Record which page each heading landed on.

        The contents list cannot know its own page numbers before the document is laid out,
        so the document is built twice: once to discover them, once to print them. Guessing
        produced a contents list pointing past the end of an 18-page document, which is the
        kind of small lie that undermines everything else in a document about evidence.
        """
        if not self.after_toc:
            return

        if not isinstance(flowable, Paragraph):
            return

        style = flowable.style.name
        if style not in ("h1", "h2"):
            return

        level = 0 if style == "h1" else 1
        text = flowable.getPlainText()

        # The contents heading is itself an h1, so without this the list begins with an
        # entry pointing at itself.
        if text.strip().lower() in ("contents", "table of contents"):
            return

        self.notify("TOCEntry", (level, text, self.page))

    # -- page furniture ---------------------------------------------------
    def _rule(self, c, y, x0=None, x1=None):
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        c.line(x0 if x0 is not None else MARGIN_X,
               y,
               x1 if x1 is not None else PAGE[0] - MARGIN_X,
               y)

    def _cover_page(self, c, doc):
        c.saveState()
        self._rule(c, PAGE[1] - 13 * mm)
        c.setFillColor(FAINT)
        c.setFont(F.body, 7.5)
        c.drawString(MARGIN_X, PAGE[1] - 10.5 * mm, self.doc_title)
        c.drawRightString(PAGE[0] - MARGIN_X, PAGE[1] - 10.5 * mm, self.doc_subtitle)
        c.restoreState()

    def _normal_page(self, c, doc):
        c.saveState()
        self._rule(c, PAGE[1] - 13 * mm)
        c.setFillColor(FAINT)
        c.setFont(F.body, 7.5)
        c.drawString(MARGIN_X, PAGE[1] - 10.5 * mm, self.doc_title)
        c.drawRightString(PAGE[0] - MARGIN_X, PAGE[1] - 10.5 * mm, self.doc_subtitle)

        self._rule(c, 12 * mm)
        c.drawString(MARGIN_X, 8.5 * mm, "collab-editor")
        c.drawCentredString(PAGE[0] / 2, 8.5 * mm, f"page {c.getPageNumber()}")
        c.restoreState()


# ── Building blocks ────────────────────────────────────────────────────────────────
def para(text: str, st: ParagraphStyle) -> Paragraph:
    return Paragraph(text, st)


def bullets(items, st: ParagraphStyle, bullet="•") -> list:
    return [Paragraph(t, st, bulletText=bullet) for t in items]


def numbered(items, st: ParagraphStyle) -> list:
    return [Paragraph(t, st, bulletText=f"{i}.") for i, t in enumerate(items, start=1)]


def code(text: str, width: float = CONTENT_W, font_size=7.6, caption: str | None = None,
         st: dict | None = None) -> list:
    """Monospace block on a tinted panel.

    Uses Preformatted rather than Paragraph so indentation survives verbatim - which matters
    enormously for code, and is why code is never routed through the markup path.
    """
    inner_w = width - 8 * mm
    pre = Preformatted(
        text.rstrip("\n"),
        ParagraphStyle(
            "pre", fontName=F.mono, fontSize=font_size, leading=font_size * 1.42,
            textColor=CODE_INK, backColor=CODE_BG,
            borderPadding=(3 * mm, 4 * mm, 3 * mm, 4 * mm),
            borderWidth=0.5, borderColor=CODE_RULE,
            spaceBefore=1 * mm, spaceAfter=1 * mm,
        ),
        maxLineLength=int(inner_w / (font_size * 0.6)),
        newLineChars="",
    )
    out = [pre]
    if caption and st:
        out.append(Paragraph(caption, st["caption"]))
    return out


def quote(text: str, st: dict) -> Table:
    """A block quote with a left rule rather than a box, so long quotes stay readable."""
    t = Table([[Paragraph(text, ParagraphStyle(
        "q", parent=st["body"], fontName=F.body_italic, textColor=MUTED,
        leftIndent=0, rightIndent=2 * mm, spaceAfter=0))]],
        colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), QUOTE_BG),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.6 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.6 * mm),
    ]))
    return t


def table(headers: list[str], rows: list[list[str]], st: dict,
          widths: list[float] | None = None, zebra: bool = True) -> Table:
    """A data table with a tinted header row.

    Cell text goes through Paragraph, so a long value wraps instead of overflowing the page -
    which is the failure mode that makes generated tables unreadable.
    """
    hs = ParagraphStyle("th", parent=st["table_head"], fontName=F.body_bold)
    data = [[Paragraph(str(h), hs) for h in headers]]
    for r in rows:
        data.append([Paragraph(str(c), st["table_cell"]) for c in r])

    if widths is None:
        widths = [CONTENT_W / len(headers)] * len(headers)

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
    if zebra:
        for i in range(1, len(data)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fafbfc")))
    t.setStyle(TableStyle(style))
    return t


def figure(path: str, caption: str, st: dict, max_w: float = CONTENT_W) -> list:
    """A screenshot, scaled to fit the content width, with a caption underneath.

    Keeps the image and its caption together: a caption stranded on the next page away from
    the figure it describes is worse than no caption.
    """
    from PIL import Image as PILImage

    with PILImage.open(path) as im:
        iw, ih = im.size

    w = min(max_w, CONTENT_W)
    h = w * ih / iw
    max_h = 105 * mm
    if h > max_h:
        h = max_h
        w = h * iw / ih

    img = Image(path, width=w, height=h)
    img.hAlign = "CENTER"
    return [KeepTogether([Spacer(1, 1.5 * mm), img, Paragraph(caption, st["caption"])])]


def callout(kind: str, text: str, st: dict) -> Table:
    """A boxed note. `kind` is one of note / gotcha / good / bad."""
    tones = {
        "note": (QUOTE_BG, ACCENT, "Note"),
        "gotcha": (colors.HexColor("#fff8e6"), WARN, "Gotcha"),
        "good": (colors.HexColor("#eefaf3"), GOOD, "Verified"),
        "bad": (colors.HexColor("#fdf0ef"), BAD, "Bug found"),
    }
    bg, edge, label = tones.get(kind, tones["note"])
    body = ParagraphStyle(
        "c", parent=st["body"], fontSize=9.3, leading=13.4, spaceAfter=0,
        textColor=INK,
    )
    inner = [
        Paragraph(f"<b>{label}</b>", ParagraphStyle(
            "cl", parent=body, fontName=F.body_bold, fontSize=8.4,
            textColor=edge, spaceAfter=1.2 * mm)),
        Paragraph(text, body),
    ]
    t = Table([[inner]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.5, edge),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
    ]))
    return t


def toc_block(entries: list[tuple[int, str, int]], st: dict) -> list:
    """A static contents list: (level, text, page).

    Built from a two-pass build rather than reportlab's TableOfContents, because the two-pass
    approach needs a canvas that can be discarded and re-run, and these documents are built in
    one shot from a known outline. Page numbers are asserted to exist rather than assumed.
    """
    out = []
    for level, text, page in entries:
        s = st["toc1"] if level == 1 else st["toc2"]
        pad = "" if level == 1 else "&nbsp;&nbsp;&nbsp;"
        dots = "&nbsp;" * 2
        out.append(Paragraph(
            f'{pad}{text}<font color="#8b95a1">{dots}</font>'
            f'<font color="#5c6570">&nbsp;{page}</font>',
            s,
        ))
    return out


def toc_flowable() -> TableOfContents:
    """An empty contents object the document fills in on its second pass."""
    toc = TableOfContents()
    # Dot leaders off. reportlab spaces the dots far enough apart that a long entry renders as
    # " . . . . . . " rather than a continuous rule, which reads as broken rather than decorative.
    toc.dotsMinLevel = 99
    toc.levelStyles = [
        ParagraphStyle(
            "toc1", fontName=F.body, fontSize=9.6, leading=14.5,
            textColor=INK, leftIndent=0, spaceBefore=3.2 * mm, firstLineIndent=0,
        ),
        ParagraphStyle(
            "toc2", fontName=F.body, fontSize=8.8, leading=12.6,
            textColor=MUTED, leftIndent=6 * mm, firstLineIndent=-1 * mm,
        ),
    ]
    return toc
