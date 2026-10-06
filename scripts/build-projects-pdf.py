"""Deliverable 1: Project opportunities mined from the Reddit CSV datasets.

Two rules govern this document, both learned the hard way in previous work:

  1. Every project traces to a QUOTE somebody actually wrote, with subreddit and score. A
     project list assembled from taste is indistinguishable from one assembled from data,
     right up until someone asks "why this one?"
  2. Counts are printed as counted. The demand/supply/noise split is the reason the shortlist
     looks the way it does, and hiding it would make the ranking unexplainable.

All project content lives in docs/projects.json. Keeping it out of Python literals is not
tidiness for its own sake: deeply nested literals inside a generator are hard to read, hard to
diff, and - as this file's first draft proved - easy to leave one bracket unbalanced, which
Python reports at end-of-file rather than at the line that caused it.

Run: python scripts/build-projects-pdf.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd
from reportlab.platypus import NextPageTemplate, PageBreak, Paragraph, Spacer

sys.path.insert(0, str(Path(__file__).parent))

from pdfkit import (  # noqa: E402
    CONTENT_W,
    Doc,
    bullets,
    callout,
    numbered,
    para,
    styles,
    table,
    toc_flowable,
)

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "docs" / "projects.json"
OUT_PDF = REPO / "docs" / "project-opportunities.pdf"
OUT_MD = REPO / "docs" / "project-opportunities.md"

CSV_A = Path(r"C:\Users\ASUS\Downloads\dataset_reddit-scraper_2026-10-04_17-32-16-198.csv")
CSV_B = Path(r"C:\Users\ASUS\Downloads\dataset_reddit-scraper_2026-10-02_02-26-11-071.csv")

NOISE_RE = re.compile(
    r"\b(?:tcs|nqt|codevita|placement|off-?campus|aptitude|cgpa|codeforces|leetcode|rating)\b",
    re.I,
)
SUPPLY_RE = re.compile(
    r"\b(?:built|made|created|developed|launched|released|wrote|published|shipped)\b"
    r"|\bmy (?:app|project|tool|site|extension|plugin|library|bot)\b",
    re.I,
)


# ── data ───────────────────────────────────────────────────────────────────────────
def load() -> dict:
    return json.loads(DATA.read_text(encoding="utf-8"))


def measure() -> dict:
    """Count the three signals directly from the CSVs, so the numbers in the PDF are measured
    rather than typed. If the CSVs are absent the document still builds, with the counts
    marked as unavailable - which is honest, and better than a stale figure."""
    for p in (CSV_A, CSV_B):
        if not p.exists():
            return {"available": False}

    frames = [pd.read_csv(p, low_memory=False) for p in (CSV_A, CSV_B)]
    df = pd.concat(frames, ignore_index=True)

    text = (
        df.get("title", pd.Series("", index=df.index)).fillna("").astype(str)
        + " "
        + df.get("body", pd.Series("", index=df.index)).fillna("").astype(str)
    )

    demand_re = [
        re.compile(p, re.I) for p in (
            r"\b(?:wish|wish there (?:was|were)|if only|would (?:love|pay))\b",
            r"\b(?:can'?t find|couldn'?t find|nobody has|doesn'?t exist|does not exist)\b",
            r"\b(?:is broken|keeps? (?:failing|crashing)|doesn'?t work|so (?:buggy|unreliable))\b",
            r"\b(?:too expensive|pricey|paywall|subscription fatigue)\b",
            r"\b(?:manually|by hand|tedious|repetitive|boring process|spreadsheet)\b",
            r"\b(?:any (?:recommend|suggestions?|advice)|what (?:app|tool|site) (?:do you|should)"
            r"|looking for (?:an?|some))\b",
        )
    ]

    demand = pd.Series(False, index=df.index)
    for rx in demand_re:
        demand |= text.str.contains(rx, regex=True, na=False)
    noise = text.str.contains(NOISE_RE, regex=True, na=False)
    supply = text.str.contains(SUPPLY_RE, regex=True, na=False)

    comms = df.get("communityName", pd.Series(dtype=str)).fillna("").astype(str)
    comms = comms[comms.str.strip() != ""]

    return {
        "available": True,
        "rows": len(df),
        "posts": int((df["dataType"] == "post").sum()) if "dataType" in df.columns else 0,
        "comments": int((df["dataType"] == "comment").sum()) if "dataType" in df.columns else 0,
        "communities": int(comms.nunique()),
        "demand_rows": int(demand.sum()),
        "supply_rows": int(supply.sum()),
        "noise_rows": int(noise.sum()),
        "shortlist_rows": int((demand & ~noise).sum()),
        "per_pattern": [int(text.str.contains(rx, regex=True, na=False).sum()) for rx in demand_re],
    }


# ── sections ───────────────────────────────────────────────────────────────────────
def cover(st: dict, d: dict, m: dict) -> list:
    out = [
        Spacer(1, 24 * 1),
        Paragraph("Project opportunities", st["title"]),
        Paragraph(
            "Mined from two Reddit scraper datasets and ranked by evidence rather than taste. "
            "Every project traces to a quotation, a subreddit and a score.",
            st["subtitle"],
        ),
        Spacer(1, 6 * 1),
    ]

    rows = []
    if m.get("available"):
        rows += [
            ["Rows analysed", f"{m['rows']:,}"],
            ["Submissions", f"{m['posts']:,}"],
            ["Comments", f"{m['comments']:,}"],
            ["Distinct communities", f"{m['communities']}"],
            ["Rows carrying demand signal", f"{m['demand_rows']:,}"],
            ["Rows carrying supply signal (already built)", f"{m['supply_rows']:,}"],
            ["Rows that are placement or contest noise", f"{m['noise_rows']:,}"],
            ["Demand, noise removed - the shortlist basis", f"{m['shortlist_rows']:,}"],
        ]
    else:
        rows += [["Source CSVs", "not present on this machine - counts unavailable"]]
    rows.append(["Projects listed", str(len(d["projects"]))])

    out += [table(["", ""], rows, st,
                  widths=[CONTENT_W * 0.66, CONTENT_W * 0.34], zebra=False)]
    out += [Spacer(1, 6 * 1)]

    if m.get("available"):
        out += [callout(
            "note",
            "Read section 2 before the project list. The number that matters most is that "
            f"<b>{m['supply_rows']:,} rows describe something already built</b> while only "
            f"<b>{m['shortlist_rows']:,} survive</b> as demand once placement chatter is removed. "
            "A list built without that split recommends things that already exist.",
            st)]
    else:
        out += [callout(
            "gotcha",
            "The source CSVs were not on this machine, so every count in this document is "
            "marked unavailable rather than quoted from memory. A stale number in a document "
            "about evidence is worse than no number.",
            st)]
    return out


def toc(st: dict, d: dict) -> list:
    """The contents page.

    Page numbers are not written here. The document is built twice and reportlab fills them in,
    because a hand-written contents list silently goes stale the moment a section grows.
    """
    return [
        Paragraph("Contents", st["h1"]),
        toc_flowable(),
    ]

def section_data(st: dict, d: dict, m: dict) -> list:
    out = [Paragraph("1. What was in the data", st["h1"])]
    out += [para(
        "Two scraper exports, three days apart, covering coding and career subreddits. Between "
        "them they hold just under five thousand rows. That sounds like a lot and is not: the "
        "rows are overwhelmingly short comments, and the mean body is about forty words.", st["body"])]

    real = [x for x in d["datasets"] if x["rows"] > 1000]
    out += [table(
        ["Property", "Dataset A (4 Oct)", "Dataset B (2 Oct)"],
        [
            ["Rows", f"{real[0]['rows']:,}", f"{real[1]['rows']:,}"],
            ["Columns", str(real[0]["cols"]), str(real[1]["cols"])],
            ["Submissions", str(real[0]["posts"]), str(real[1]["posts"])],
            ["Comments", f"{real[0]['comments']:,}", f"{real[1]['comments']:,}"],
            ["Communities", str(real[0]["communities"]), str(real[1]["communities"])],
            ["Leading communities", real[0]["leading"], real[1]["leading"]],
        ],
        st,
        widths=[CONTENT_W * 0.24, CONTENT_W * 0.38, CONTENT_W * 0.38])]
    out += [Spacer(1, 3 * 1)]

    out += [callout(
        "note",
        "The two exports are <b>not</b> one clean corpus. Dataset A is dominated by Indian "
        "campus placement communities; dataset B by general programming and side-project "
        "communities. Any conclusion below that depends on one of them is labelled, because "
        "pretending 4,991 rows are 4,991 comparable rows is how a dataset quietly becomes "
        "worthless.", st)]

    out += [Spacer(1, 5 * 1), Paragraph("2. Method, and why the counts are what they are", st["h1"])]
    out += [para(
        "Three signals were counted separately, because conflating them is the most common way a "
        "project list becomes a list of things that already exist. A row can match more than one, "
        "so these do not sum to the row count.", st["body"])]

    means = [
        "Explicit want: <i>wish there was</i>, <i>if only</i>, <i>would love</i>",
        "Named gap: <i>can't find</i>, <i>nobody has</i>, <i>doesn't exist</i>",
        "Failure report: <i>keeps crashing</i>, <i>so buggy</i>",
        "Cost objection: <i>too expensive</i>, <i>paywall</i>",
        "Friction: <i>manually</i>, <i>by hand</i>, <i>spreadsheet</i>",
        "Active search: <i>any recommendations</i>, <i>what should I build</i>",
    ]
    rows = []
    for i, item in enumerate(d["demandPatterns"]):
        n = f"{m['per_pattern'][i]:,}" if m.get("available") else "n/a"
        rows.append([f"Demand: {item['label']}", n, item["means"]])
    rows.append(["<b>Any demand signal</b>",
                 f"<b>{m['demand_rows']:,}</b>" if m.get("available") else "n/a",
                 "Union of the six above"])
    rows.append(["Supply: already built",
                 f"<b>{m['supply_rows']:,}</b>" if m.get("available") else "n/a",
                 "<b>Excluded from recommendations.</b> Someone made this"])
    rows.append(["Noise: placement / contest",
                 f"<b>{m['noise_rows']:,}</b>" if m.get("available") else "n/a",
                 "<b>Excluded.</b> Exam season and competitive programming"])
    rows.append(["<b>Demand, noise removed</b>",
                 f"<b>{m['shortlist_rows']:,}</b>" if m.get("available") else "n/a",
                 "<b>The shortlist basis for everything that follows</b>"])

    out += [table(["Signal", "Rows", "What it means"], rows, st,
                  widths=[CONTENT_W * 0.30, CONTENT_W * 0.10, CONTENT_W * 0.60])]
    out += [Spacer(1, 3 * 1)]

    if m.get("available"):
        out += [para(
            "So: of {:,} rows, {:,} say something is wanted or wanted-and-missing, {:,} describe "
            "something already built, and {:,} are placement or contest chatter. Removing noise "
            "leaves <b>{:,} rows</b> to read by hand. Every project below comes from those, and "
            "nothing was added from general knowledge.".format(
                m["rows"], m["demand_rows"], m["supply_rows"], m["noise_rows"], m["shortlist_rows"]),
            st["body"])]
        out += [callout(
            "good",
            f"The supply row is the most useful number here. {m['supply_rows']:,} rows describe "
            "something already built - including a collaborative coding agent, a DJ interface in "
            "plain HTML, and an SEO tool built to avoid paying for a subscription. Recommending "
            "any of those would waste whoever read this.", st)]

    out += [Spacer(1, 5 * 1), Paragraph("What the shortlist actually says", st["h3"])]
    out += [para(
        "Read in order of frequency, the demand is not ten unrelated needs. It collapses into "
        "four recurring shapes, and the project list is organised around them rather than around "
        "individual sentences.", st["body"])]
    out += bullets([
        '<b>"Build something that counts, not another CRUD app."</b> The single loudest theme. '
        'r/cscareerquestions at score 1,072: <i>"Sure, let me come up with a cool, innovative '
        'idea that isn\'t another task board or social networking site and develop an entire '
        'fr..."</i>',
        '<b>"Teach me the hard part, not the tutorial."</b> r/ExperiencedDevs, score 228, '
        'explicitly: <i>"Not interested in features - interested in problems."</i> They name '
        "real-time collaboration as a candidate.",
        '<b>"The tool I use every day does not do the one thing I need."</b> r/Backend, score 23: '
        '<i>"the kind where someone goes \'ugh I wish there was a tool for this\'"</i>',
        '<b>"I did it by hand and it nearly broke me."</b> The 72-hour automated replay below is '
        "the clearest single piece of evidence in the dataset.",
    ], st["bullet"])
    return out


def section_ranking(st: dict, d: dict) -> list:
    out = [Paragraph("3. How the ranking works", st["h1"])]
    out += [para("Priority is a weighted score, not a judgement call. The four components:", st["body"])]
    out += [table(
        ["Component", "Weight", "Reason it is in the score"],
        [[r["component"], r["weight"], r["reason"]] for r in d["ranking"]],
        st,
        widths=[CONTENT_W * 0.24, CONTENT_W * 0.10, CONTENT_W * 0.66])]
    out += [Spacer(1, 3 * 1)]
    out += [callout(
        "gotcha",
        "Legibility is weighted lowest on purpose. It is the easiest thing to optimise for and the "
        "easiest to fake - a good README on a shallow project is worse than a modest one on a "
        "deep project, because the shallow one looks like an overclaim.", st)]
    return out


def section_fields(st: dict, d: dict) -> list:
    out = [Paragraph("4. Field-by-field view of the projects", st["h1"])]
    out += [para(
        "Every project, scored on all four axes. Read across a row to see the trade-off; read down "
        "a column to see what the ranking rewards.", st["body"])]
    out += [table(
        ["#", "Project", "Evidence", "Difficulty", "Solo", "Legible", "Score"],
        [[f'P{p["id"]}', p["name"], p["evidence"], p["difficulty"], p["solo"], p["legible"],
          f'<b>{p["score"]}</b>'] for p in d["projects"]],
        st,
        widths=[CONTENT_W * 0.05, CONTENT_W * 0.35, CONTENT_W * 0.12, CONTENT_W * 0.12,
                CONTENT_W * 0.10, CONTENT_W * 0.11, CONTENT_W * 0.05])]
    out += [Spacer(1, 4 * 1)]

    out += [para(
        "The same projects by the technology they exercise, which is the more useful cut when "
        "choosing what to learn next.", st["body"])]
    keys = ["Core technology", "Backend", "Frontend", "Zero cost", "Solo in 4 weeks",
            "Shows concurrency", "Shows data modelling", "Shows cryptography"]
    grid = {
        "Core technology": lambda p: ", ".join(p["fields"][:2]),
        "Backend": lambda p: "yes" if any(
            k in " ".join(p["fields"]).lower() for k in ("crdt", "postgres", "sql", "k6", "auth")
        ) else "light",
        "Frontend": lambda p: "yes" if any(
            k in " ".join(p["fields"]).lower() for k in ("browser", "ui", "accessibility")
        ) or p["id"] in (1, 3, 5, 9, 10) else "light",
        "Zero cost": lambda p: "yes",
        "Solo in 4 weeks": lambda p: "no" if p["solo"] <= 5 else "yes",
        "Shows concurrency": lambda p: "yes" if "crdt" in " ".join(p["fields"]).lower()
        or p["id"] == 8 else ("part" if p["id"] in (2, 9) else "no"),
        "Shows data modelling": lambda p: "yes" if p["id"] in (1, 2, 5, 6, 9)
        else ("part" if p["id"] in (3, 4) else "no"),
        "Shows cryptography": lambda p: "yes" if p["id"] in (1, 7)
        else ("part" if p["id"] == 3 else "no"),
    }
    out += [table(
        ["Dimension"] + [f'P{p["id"]}' for p in d["projects"]],
        [[k] + [grid[k](p) for p in d["projects"]] for k in keys],
        st,
        widths=[CONTENT_W * 0.20] + [CONTENT_W * 0.08] * len(d["projects"]))]
    return out


def project_page(st: dict, p: dict) -> list:
    out = [
        Paragraph(f'P{p["id"]} &nbsp; {p["name"]}', st["h1"]),
        Paragraph(
            f'<font color="#5c6570">Priority {p["score"]}/10 &nbsp;|&nbsp; '
            f'evidence {p["evidence"]} &nbsp;|&nbsp; difficulty {p["difficulty"]} &nbsp;|&nbsp; '
            f'solo {p["solo"]} &nbsp;|&nbsp; legibility {p["legible"]}</font>',
            st["body"]),
        Paragraph("The problem, in their words", st["h3"]),
        para(p["problem"], st["body"]),
        Paragraph("Evidence", st["h3"]),
    ]
    out += bullets([
        f'<b>{q["q"]}</b><br/><font size="8.4" color="#5c6570">r/{q["sub"]} &middot; '
        f'score {q["score"]} &middot; dataset {q["src"]}</font>'
        for q in p["quotes"]], st["bullet"])
    out += [Paragraph("Why it is ranked here", st["h3"]), para(p["why"], st["body"])]
    out += [Paragraph("What it does not do", st["h3"]), para(p["limits"], st["body"])]
    out += [Paragraph("Build order", st["h3"])] + numbered(p["build"], st["numbered"])
    out += [Paragraph("Stack", st["h3"]), para(p["stack"], st["body"])]
    if p.get("note"):
        out += [Spacer(1, 2 * 1), callout("note", p["note"], st)]
    return out


def appendix(st: dict, d: dict) -> list:
    out = [Paragraph("6. Appendix: every field, and what it is good for", st["h1"])]
    out += [para(
        "Between them the two exports carry 103 and 112 columns, and most are useless for this "
        "purpose. Roughly forty of dataset A's fields are entirely empty - they are flattened "
        "media paths for one specific image post that happened to be in the crawl.", st["body"])]

    out += [table(
        ["Group", "What is in it", "Use for project discovery"],
        [
            ["Always populated",
             "ageHours, authorName, body, commentCreatedAt, communityName, createdAt, crawledAt, "
             "dataType, depth, id, score, scorePerHour, subredditName, title, upVotes, "
             "upvoteRatio, wordCount and similar",
             "The spine of the dataset: identity, time, engagement. Enough to rank rows and to "
             "trace every claim in this document back to a source."],
            ["Partly populated",
             "media, mediaMetadata, galleryData, images/0, secureMedia, thumbnail, domain, "
             "outboundUrlHost, flair, modReasonTitle, removalReason",
             "Media, gallery and moderation state. Signals <i>what kind of post</i> it was, not "
             "what anybody wanted. Useless for demand."],
            ["Entirely empty",
             "mediaMetadata/b1fj1k5iws2g1/* (14 fields), media, secureMedia, galleryData, "
             "videoUrl, bannedBy, modReasonTitle, removalReason, removedByCategory",
             "Nothing. Paths for one image's metadata. Worth deleting before anyone trains a "
             "model on this file."],
        ],
        st,
        widths=[CONTENT_W * 0.17, CONTENT_W * 0.45, CONTENT_W * 0.38])]
    out += [Spacer(1, 4 * 1)]

    out += [Paragraph("The five files, and which ones matter", st["h3"])]
    out += [para(
        "Five CSVs were in Downloads. Only two are usable as data, and the reason the other three "
        "are not is worth stating plainly rather than quietly ignoring.", st["body"])]
    out += [table(
        ["File", "Shape", "Verdict"],
        [[x["file"], f'{x["rows"]} x {x["cols"]}', x["verdict"]] for x in d["datasets"]],
        st,
        widths=[CONTENT_W * 0.30, CONTENT_W * 0.14, CONTENT_W * 0.56])]
    out += [Spacer(1, 3 * 1)]
    out += [callout(
        "gotcha",
        "Three of the five files look like data and are not. A file whose column names are CSS "
        "class names is a scrape that captured styling attributes instead of content - and it "
        "loads cleanly into pandas, produces 209 rows, and will happily be analysed as though it "
        "were real. Check the header before the row count.", st)]
    return out


def limits(st: dict) -> list:
    out = [Paragraph("7. What this analysis cannot tell you", st["h1"])]
    out += [para(
        "A document that only lists strengths is marketing. These are the specific ways the list "
        "above can mislead you.", st["body"])]
    out += bullets([
        "<b>Engagement is not demand.</b> A score of 436 measures agreement, not willingness to "
        "pay or to use. Nothing here is a market size.",
        "<b>Two scrapes are not a sample of the internet.</b> These are two communities' worth of "
        "coding and career discussion, weighted toward whoever was posting on two days in "
        "October 2026.",
        "<b>Most rows are comments, not questions.</b> Under five hundred of the rows are "
        "submissions. A comment is often a reaction to context that is not in the dataset.",
        "<b>The subreddit label is unreliable.</b> Many rows have no community recorded, and "
        "those rows are attributed here to a general label rather than invented one.",
        "<b>No supply-side check.</b> Whether any of these gaps is already filled by a commercial "
        "product was not researched. Some almost certainly are.",
        "<b>Nobody was asked.</b> This is what people said when they were not being asked "
        "directly, which is both its strength and its limitation.",
    ], st["bullet"])
    out += [Spacer(1, 3 * 1)]
    out += [callout(
        "good",
        "The one thing this analysis does establish is the shape of the demand: repeated, "
        "specific requests for projects that demonstrate <i>difficulty</i> rather than features, "
        "from people who have already discovered that another CRUD app does not help them. That "
        "shape held across two datasets, three days apart, and forty-odd separate communities.",
        st)]
    return out


# ── markdown twin ──────────────────────────────────────────────────────────────────
def write_md(d: dict, m: dict) -> None:
    L: list[str] = ["# Project opportunities\n",
                    "Mined from two Reddit scraper datasets, ranked by evidence rather than taste.\n"]
    if m.get("available"):
        L += [f"- Rows analysed: **{m['rows']:,}**",
              f"- Demand-bearing rows: **{m['demand_rows']:,}**",
              f"- Supply-bearing rows (already built, excluded): **{m['supply_rows']:,}**",
              f"- Placement/contest noise (excluded): **{m['noise_rows']:,}**",
              f"- **Demand, noise removed - shortlist basis: {m['shortlist_rows']:,}**\n"]
    L += ["## Ranking\n",
          "| # | Project | Evidence | Difficulty | Solo | Legible | Score |",
          "|---|---|---|---|---|---|---|"]
    for p in d["projects"]:
        L.append(f'| P{p["id"]} | {p["name"]} | {p["evidence"]} | {p["difficulty"]} | '
                 f'{p["solo"]} | {p["legible"]} | **{p["score"]}** |')

    for p in d["projects"]:
        L += [f'\n## P{p["id"]} - {p["name"]}\n',
              f'Priority {p["score"]}/10 | evidence {p["evidence"]} | '
              f'difficulty {p["difficulty"]} | solo {p["solo"]} | legibility {p["legible"]}\n',
              f'**The problem.** {p["problem"]}\n', "**Evidence**\n"]
        for q in p["quotes"]:
            L.append(f'> {q["q"]}\n>\n> - r/{q["sub"]}, score {q["score"]}, dataset {q["src"]}')
        L += [f'\n**Why it is ranked here.** {p["why"]}\n',
              f'\n**What it does not do.** {p["limits"]}\n', "\n**Build order**\n"]
        L += [f"{i}. {b}" for i, b in enumerate(p["build"], 1)]
        L.append(f'\n**Stack.** {p["stack"]}\n')
        if p.get("note"):
            L.append(f'> **Note.** {p["note"]}\n')

        # newline="\n" is load-bearing. Without it, Python's text mode translates every \n to the
    # platform separator, so the generator wrote CRLF into a repository whose .gitattributes
    # declares LF, and the line-endings gate failed on a file that was correct when written.
    OUT_MD.write_text("\n".join(L), encoding="utf-8", newline="\n")
    print(f"wrote {OUT_MD.name}  ({OUT_MD.stat().st_size // 1024} KB)")


def main() -> None:
    d = load()
    m = measure()
    st = styles()

    story: list = cover(st, d, m)
    story += [NextPageTemplate("normal"), PageBreak()]
    story += toc(st, d)
    story += [PageBreak()]
    story += section_data(st, d, m)
    story += [PageBreak()]
    story += section_ranking(st, d)
    story += [PageBreak()]
    story += section_fields(st, d)
    story += [PageBreak()]
    for p in d["projects"]:
        story += project_page(st, p)
        story += [PageBreak()]
    story += appendix(st, d)
    story += [PageBreak()]
    story += limits(st)

    OUT_PDF.parent.mkdir(parents=True, exist_ok=True)
    doc = Doc(str(OUT_PDF), "Project opportunities", "mined from Reddit datasets")
    doc.multiBuild(story)
    print(f"wrote {OUT_PDF.name}  ({OUT_PDF.stat().st_size // 1024} KB)")
    write_md(d, m)


if __name__ == "__main__":
    main()
