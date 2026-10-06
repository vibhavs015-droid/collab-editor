"""Extract project-shaped signals from the Reddit CSVs.

The goal is a defensible list of project ideas, so this separates three things that are easy to
conflate:

  1. DEMAND   - what people say they want, need, cannot find, or complain about
  2. SUPPLY   - what people say they have already built
  3. NOISE    - placement advice, memes, exam chatter, which is most of these subreddits

A project list built without separating these ends up being a list of things that already exist,
which is the least useful output available.

Run: python scripts/.extract-signals.py <csv> [<csv> ...]
"""

import re
import sys
from collections import Counter

import pandas as pd

# Phrases that mark a wish, a gap, or a frustration. Deliberately specific: a bare "need" or
# "want" matches too much ordinary text to be evidence of anything.
DEMAND_PATTERNS = {
    "wishes it existed": r"\b(?:wish|wish there (?:was|were)|if only|would (?:love|pay) (?:if|for|to))\b",
    "cannot find": r"\b(?:can'?t find|couldn'?t find|no one has|nobody has|doesn'?t exist|does not exist|doesn'?t seem to exist)\b",
    "is broken": r"\b(?:is broken|keeps? (?:failing|crashing)|doesn'?t work|not working|so (?:buggy|unreliable))\b",
    "too expensive": r"\b(?:too expensive|afford|pricey|cost a (?:lot|fortune)|paywall|subscription fatigue)\b",
    "too hard / missing docs": r"\b(?:documentation is (?:awful|terrible|bad|nonexistent)|no docs?|undocumented|steep learning curve)\b",
    "manual / tedious": r"\b(?:manually|by hand|tedious|repetitive|boring process|spreadsheet)\b",
    "asking for a tool": r"\b(?:is there (?:any|an? free) (?:app|tool|site|extension|app)|anyone (?:know|have) (?:a|an) (?:app|tool|extension))\b",
    "recommendations wanted": r"\b(?:any (?:recommend|suggestions?|advice)|what (?:app|tool|site|extension|setup) (?:do you|should)|looking for (?:an?|some))\b",
}

# What people say they built. Used to avoid recommending the same thing twice.
SUPPLY_PATTERN = (
    r"\b(?:i(?:'| a)?m |i )?(?:built|made|created|developed|launched|released|wrote|published|shipped)\b"
    r"|\bmy (?:app|project|tool|site|extension|plugin|library|bot)\b"
)

NOISE_PATTERNS = {
    "placement / exam": r"\b(?:tcs|nqt|codevita|infy hyscore|hackerrank|placement|off-?campus|resume|aptitude|interview (?:round|experience)|cgpa|percentage|semester)\b",
    "competitive programming": r"\b(?:codeforces|leetcode|rating|div2|div3|contest|dp problem|graph|segment tree)\b",
    "meme / low effort": r"\b(?:lol|lmao|😂|💀|ratio|cope|seggs|bricked|goated)\b",
}

URL = re.compile(r"https?://\S+")


def text_of(df: pd.DataFrame) -> pd.Series:
    """Title and body as one string, with URLs stripped so they do not dominate keyword counts."""
    parts = []
    for col in ("title", "body"):
        if col in df.columns:
            s = df[col].fillna("").astype(str)
            parts.append(s)
    joined = parts[0] if not parts else parts[0]
    for extra in parts[1:]:
        joined = joined + " " + extra
    return joined.str.replace(URL, " ", regex=True)


def main(paths: list[str]) -> None:
    frames = []
    for p in paths:
        df = pd.read_csv(p, low_memory=False)
        df["__source"] = p.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)

    print(f"combined rows: {len(df):,}")
    if "dataType" in df.columns:
        print(df["dataType"].value_counts().to_string())
    print()

    text = text_of(df)

    print("=" * 70)
    print("SIGNAL COUNTS (rows matching, not total matches)")
    print("=" * 70)

    demand_rows = pd.Series(False, index=df.index)
    for label, pat in DEMAND_PATTERNS.items():
        hit = text.str.contains(pat, case=False, regex=True, na=False)
        demand_rows |= hit
        print(f"  {label:26} {hit.sum():5,}")

    supply = text.str.contains(SUPPLY_PATTERN, case=False, regex=True, na=False)
    print(f"\n  {'(supply: already built)':26} {supply.sum():5,}")

    noise_rows = pd.Series(False, index=df.index)
    for label, pat in NOISE_PATTERNS.items():
        hit = text.str.contains(pat, case=False, regex=True, na=False)
        noise_rows |= hit
        print(f"  {'(noise) ' + label:26} {hit.sum():5,}")

    print()
    print(f"  demand-bearing rows: {demand_rows.sum():,}")
    print(f"  supply-bearing rows: {supply.sum():,}")
    print(f"  noise-bearing rows:  {noise_rows.sum():,}")
    clean = demand_rows & ~noise_rows
    print(f"  demand AND not noise: {clean.sum():,}   <- the shortlist basis")

    # Keywords, restricted to the shortlist so placement chatter cannot skew them.
    print()
    print("=" * 70)
    print("TOP KEYWORDS in demand-bearing, non-noise rows")
    print("=" * 70)
    STOP = set(
        """the a an and or but if then than that this these those for with without from into to of in on at by
        is are was were be been being do does did doing have has had having i you he she it we they me my your
        can could should would will just about really very much more most some any all how what why when where
        which who whom there here get got make made use used using one two also like well know think""".split()
    )
    words = Counter()
    for t in text[clean]:
        for w in re.findall(r"[a-z][a-z0-9+#.-]{2,}", str(t).lower()):
            w = w.strip(".-")
            if w not in STOP and not w.isdigit():
                words[w] += 1
    print("  " + ", ".join(f"{w}({n})" for w, n in words.most_common(70)))

    # The shortlist itself, highest engagement first, so a human can check the reasoning.
    print()
    print("=" * 70)
    print("SHORTLIST: demand, non-noise, ranked by score")
    print("=" * 70)
    sub = df[clean].copy()
    score_col = "score" if "score" in sub.columns else None
    if score_col:
        sub[score_col] = pd.to_numeric(sub[score_col], errors="coerce").fillna(0)
        sub = sub.sort_values(score_col, ascending=False)

    for i, (_, row) in enumerate(sub.head(40).iterrows(), start=1):
        body = " ".join(str(row.get("body", "")).split())[:300]
        title = " ".join(str(row.get("title", "")).split())[:110]
        comm = row.get("communityName", row.get("subredditName", "?"))
        sc = row.get("score", "?")
        print(f"\n[{i}] r/{comm}  score={sc}")
        if title and str(title).lower() != "nan":
            print(f"    title: {title}")
        print(f"    body:  {body}")

    # Supply, so already-built things can be excluded rather than reinvented.
    print()
    print("=" * 70)
    print("WHAT PEOPLE SAY THEY ALREADY BUILT (do not recommend these)")
    print("=" * 70)
    for _, row in df[supply].head(30).iterrows():
        body = " ".join(str(row.get("body", "")).split())[:240]
        comm = row.get("communityName", "?")
        print(f"  - r/{comm}: {body}")


if __name__ == "__main__":
    main(sys.argv[1:])
