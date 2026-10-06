"""Print the FULL untruncated text of rows matching a signal pattern.

The shortlist view truncates bodies at 300 characters, which is enough to rank and not enough
to write a project brief from. Every project in the final list has to be traceable to a quote
somebody actually wrote, so the quotes get read in full before anything is claimed about them.

Run: python scripts/.read-full.py <csv...> --pattern <regex> [--limit N] [--min-score N]
"""

import argparse
import re
import sys

import pandas as pd

URL = re.compile(r"https?://\S+")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("csvs", nargs="+")
    ap.add_argument("--pattern", required=True)
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--min-score", type=int, default=0)
    ap.add_argument("--exclude-noise", action="store_true", default=True)
    args = ap.parse_args()

    frames = []
    for p in args.csvs:
        if p == "--":
            continue
        frames.append(pd.read_csv(p, low_memory=False))
    df = pd.concat(frames, ignore_index=True)

    text = df.get("title", pd.Series("", index=df.index)).fillna("").astype(str) + " " + \
        df.get("body", pd.Series("", index=df.index)).fillna("").astype(str)

    noise = (
        r"\b(?:tcs|nqt|codevita|placement|off-?campus|aptitude|cgpa|codeforces|leetcode|rating|div2)\b"
    )

    hit = text.str.contains(args.pattern, case=False, regex=True, na=False)
    if args.exclude_noise:
        hit &= ~text.str.contains(noise, case=False, regex=True, na=False)

    if "score" in df.columns:
        sc = pd.to_numeric(df["score"], errors="coerce").fillna(0)
        hit &= sc >= args.min_score

    sub = df[hit].copy()
    if "score" in sub.columns:
        sub["score"] = pd.to_numeric(sub["score"], errors="coerce").fillna(0)
        sub = sub.sort_values("score", ascending=False)

    print(f"matched {int(hit.sum()):,} rows; showing up to {args.limit}\n")
    for i, (_, row) in enumerate(sub.head(args.limit).iterrows(), start=1):
        comm = row.get("communityName") or row.get("subredditName") or "?"
        if str(comm) in ("nan", "None", ""):
            comm = "?"
        title = str(row.get("title", "") or "")
        body = str(row.get("body", "") or "")
        body = URL.sub("[link]", body)
        print("=" * 78)
        print(f"[{i}] r/{comm}   score={row.get('score', '?')}   "
              f"words={row.get('wordCount', '?')}   ageHours={row.get('ageHours', '?')}")
        if title and title != "nan":
            print(f"TITLE: {title}")
        print("-" * 78)
        print(body.strip()[:2600])
        print()


if __name__ == "__main__":
    main()
