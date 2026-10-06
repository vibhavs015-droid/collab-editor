"""Deliverable: a plain, direct list of every project from the Reddit analysis.

Deliberately plainer than docs/project-opportunities.pdf. That document argues a position -
it ranks ten projects by a weighted score and explains the method. This one does not argue: it
lists all 66, with the Reddit evidence for each, in the order they were given.

The one thing it does add is verification. Each project carries a note saying whether an
independent search of the source CSVs found the row, and whether the stated score matched.

Content lives in docs/all-projects.json.

Run: python scripts/build-all-projects-pdf.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, Spacer, Table, TableStyle

sys.path.insert(0, str(Path(__file__).parent))

from pdfkit import (  # noqa: E402
    ACCENT, CONTENT_W, Doc, F, GOOD, INK, MUTED, RULE, WARN, BAD,
    bullets, callout, numbered, para, styles, table, toc_flowable,
)

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "docs" / "all-projects.json"
OUT_PDF = REPO / "docs" / "all-projects.pdf"
OUT_MD = REPO / "docs" / "all-projects.md"

TONE = {
    "CONFIRMED": ("ok", GOOD, "confirmed in the CSVs, score matches"),
    "VARIANT": ("note", WARN, "located, wording differs"),
    "UNSTATED": ("muted", MUTED, "located, no score was claimed"),
}


def verification_badge(text: str | None) -> str:
    if not text or text not in TONE:
        return ""
    _, colour, label = TONE[text]
    return f'<font size="7.6" color="#{colour.hexval()[2:]}">[{text}] {label}</font>'


def cover(st: dict, d: dict) -> list:
    v = d["verification"]
    total = sum(len(c["projects"]) for c in d["categories"])

    out = [
        Spacer(1, 24 * 1),
        Paragraph("All projects from the Reddit data", st["title"]),
        Paragraph(
            f'{total} project ideas across {len(d["categories"])} categories, each with the '
            "Reddit evidence behind it. Plain list, no ranking argument.", st["subtitle"]),
        Spacer(1, 6 * 1),
    ]

    out += [table(
        ["Verification of this list against the source CSVs", ""],
        [
            ["Claims independently checked", str(v["claims_checked"])],
            ["Confirmed - row found and score matched", str(v["confirmed"])],
            ["Located, wording differs", str(v["located_variant_wording"])],
            ["<b>Stated scores that were wrong</b>", f'<b>{v["score_mismatches"]}</b>'],
            ["<b>Claims that could not be found at all</b>", f'<b>{v["fabricated"]}</b>'],
        ],
        st, widths=[CONTENT_W * 0.66, CONTENT_W * 0.34], zebra=False)]
    out += [Spacer(1, 6 * 1)]

    out += [callout(
        "good",
        f'Every score stated in this list was checked against all 4,991 rows of the two scraper '
        f'CSVs. <b>{v["confirmed"]} matched exactly and {v["score_mismatches"]} were wrong.</b> '
        "Three phrases could not be found verbatim; all three were relocated with different "
        "wording, and the corrected wording is what appears below.", st)]

    out += [Spacer(1, 5 * 1), Paragraph("Contents", st["h1"]), toc_flowable()]
    return out


def category_page(st: dict, cat: dict) -> list:
    out = [
        Paragraph(f'Category {cat["key"]} - {cat["title"]}', st["h1"]),
        Paragraph(f'<font color="#5c6570">{cat["medal"]}</font>', st["body"]),
    ]

    rows = []
    for p in cat["projects"]:
        score = f'{p["score"]}' if p.get("score") is not None else "-"
        rows.append([str(p["n"]), p["idea"], score, p["verified"]])
    out += [table(
        ["#", "Project idea", "Score", "Verification"],
        rows, st,
        widths=[CONTENT_W * 0.05, CONTENT_W * 0.60, CONTENT_W * 0.10, CONTENT_W * 0.25])]
    return out


def evidence_section(st: dict, cat: dict) -> list:
    """One page of evidence per category: each project's quote and verdict."""
    out = [Paragraph(f'Category {cat["key"]} - the Reddit evidence', st["h1"])]

    for p in cat["projects"]:
        block = [Paragraph(f'{p["n"]}. {p["idea"]}', st["h3"])]
        block.append(Paragraph(f'<i>{p["evidence"]}</i>', st["body"]))
        if p.get("verdict"):
            block.append(Paragraph(f'<b>Verdict.</b> {p["verdict"]}', st["body"]))
        badge = verification_badge(p.get("verified"))
        if badge:
            block.append(Paragraph(badge, st["body"]))
        out += block

    return out


def top_five(st: dict, d: dict) -> list:
    out = [Paragraph("Top 5, and why each one stands out", st["h1"])]
    out += [para(
        "The five the analysis singles out, with the reasoning given for each. Ranked, because "
        "these five are a judgement rather than a category.", st["body"])]

    for i, t in enumerate(d["topFive"], 1):
        out.append(Paragraph(f'{i}. {t["medal"]}', st["h2"]))
        out.append(Paragraph(f'<i>{t["quote"]}</i>', st["body"]))
        out.append(Paragraph(f'<b>Why it stands out.</b> {t["why"]}', st["body"]))
        badge = verification_badge(t.get("verified"))
        if badge:
            out.append(Paragraph(badge, st["body"]))
        out.append(Spacer(1, 2 * 1))

    out += [Paragraph("Cross-checks", st["h2"])]
    out += [para(
        "Five further claims from the same analysis, verified the same way. Included because a "
        "verification section that only shows its successes is not a verification section.", st["body"])]
    out += [table(
        ["Claim", "Score", "Verification"],
        [[c["claim"], str(c["score"]), c["verified"]] for c in d["crossChecks"]],
        st, widths=[CONTENT_W * 0.58, CONTENT_W * 0.12, CONTENT_W * 0.30])]
    return out


def write_md(d: dict) -> None:
    v = d["verification"]
    total = sum(len(c["projects"]) for c in d["categories"])
    L = [f"# All projects from the Reddit data\n",
         f"{total} project ideas across {len(d['categories'])} categories, each with the Reddit "
         "evidence behind it.\n",
         "## Verification\n",
         f"- Claims checked against the source CSVs: **{v['claims_checked']}**",
         f"- Confirmed (row found, score matched): **{v['confirmed']}**",
         f"- Located, wording differs: **{v['located_variant_wording']}**",
         f"- **Stated scores that were wrong: {v['score_mismatches']}**",
         f"- **Claims not found at all: {v['fabricated']}**\n"]

    for cat in d["categories"]:
        L += [f"\n## Category {cat['key']} - {cat['title']}\n",
              f"*{cat['medal']}*\n",
              "| # | Project idea | Score | Verification |", "|---|---|---|---|"]
        for p in cat["projects"]:
            score = p["score"] if p.get("score") is not None else "-"
            L.append(f'| {p["n"]} | {p["idea"]} | {score} | {p["verified"]} |')

        L.append("")
        for p in cat["projects"]:
            L += [f'\n**{p["n"]}. {p["idea"]}**\n', f'> {p["evidence"]}\n']
            if p.get("verdict"):
                L.append(f'*Verdict.* {p["verdict"]}\n')
            if p.get("verified"):
                L.append(f'[{p["verified"]}]\n')

    L.append("\n## Top 5, and why each one stands out\n")
    for i, t in enumerate(d["topFive"], 1):
        L += [f"\n### {i}. {t['medal']}\n", f'> {t["quote"]}\n', f"**Why it stands out.** {t['why']}\n"]
        if t.get("verified"):
            L.append(f'[{t["verified"]}]\n')

    L += ["\n## Cross-checks\n", "| Claim | Score | Verification |", "|---|---|---|"]
    for c in d["crossChecks"]:
        L.append(f'| {c["claim"]} | {c["score"]} | {c["verified"]} |')

    # `newline="\n"` for the same reason as the other generator: text mode would otherwise write
    # CRLF into a repository whose .gitattributes declares LF.
    #
    # The trailing "\n" is load-bearing too. A file whose last byte is not a newline fails the
    # line-endings gate, which is an unhelpful way to discover that a generated document is
    # missing its terminator - it reads as an encoding problem rather than a missing newline.
    OUT_MD.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT_MD.name}  ({OUT_MD.stat().st_size // 1024} KB)")


def main() -> None:
    d = json.loads(DATA.read_text(encoding="utf-8"))
    st = styles()

    story: list = cover(st, d)
    for cat in d["categories"]:
        story += [PageBreak()]
        story += category_page(st, cat)
        story += [PageBreak()]
        story += evidence_section(st, cat)
    story += [PageBreak()]
    story += top_five(st, d)

    Doc(str(OUT_PDF), "All projects from the Reddit data", "66 ideas, evidence, verified").multiBuild(story)
    print(f"wrote {OUT_PDF.name}  ({OUT_PDF.stat().st_size // 1024} KB)")
    write_md(d)


if __name__ == "__main__":
    main()
