"""Independently verify distinctive claims against the source CSVs.

The project list being formatted came from outside this repository. Several of its claims are
checkable against the data - a distinctive phrase plus a score is a fingerprint - and quoting a
score as fact without checking it would be exactly the failure this project has been guarding
against all along.

A claim is CONFIRMED only if a row containing a distinctive phrase exists AND reports the
stated score. Anything else is reported as NOT FOUND, which means "could not be located", not
"is false".

Run: python scripts/.verify-claims.py <claims.json> <csv> [<csv> ...]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd


def norm(text: str) -> str:
    """Collapse whitespace and case, so a quote split across lines still matches."""
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def main() -> None:
    claims = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    frames = [pd.read_csv(p, low_memory=False) for p in sys.argv[2:]]
    df = pd.concat(frames, ignore_index=True)

    df["score"] = pd.to_numeric(df.get("score"), errors="coerce").fillna(0).astype(int)

    # A plain Python join, not a Series: an all-empty column makes pandas return a scalar string
    # rather than a Series, and indexing a DataFrame with a string picks a column instead of a
    # boolean mask - which fails in a way that reads like a data problem rather than a typing one.
    parts = []
    for col in ("title", "body"):
        if col in df.columns:
            parts.append([norm(v) for v in df[col].fillna("").tolist()])
        else:
            parts.append([""] * len(df))
    haystack = pd.Series([a + " " + b for a, b in zip(*parts)], index=df.index)

    ok = miss = score_off = 0
    for c in claims:
        needle = norm(c["probe"])
        hits = df[haystack.str.contains(re.escape(needle), na=False)]

        if len(hits) == 0:
            print(f'  NOT FOUND  score {"?" if c.get("score") is None else c["score"]:>6}  {c["label"]}')
            miss += 1
            continue

        best = hits.loc[hits["score"].idxmax()]
        got = int(best["score"])
        want = c.get("score")

        if want is None:
            print(f'  found      score {got:>6}  {c["label"]}  ({len(hits)} row(s))')
            ok += 1
        elif got == int(want):
            print(f'  CONFIRMED  score {got:>6}  {c["label"]}  ({len(hits)} row(s))')
            ok += 1
        else:
            print(f'  SCORE DIFF stated {want:>5} got {got:>5}  {c["label"]}  ({len(hits)} row(s))')
            score_off += 1

    print()
    print(f"  confirmed or located : {ok}")
    print(f"  score differs        : {score_off}")
    print(f"  not located          : {miss}")
    print(f"  total claims checked : {len(claims)}")


if __name__ == "__main__":
    main()
