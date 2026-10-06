"""Profile the Reddit CSVs so the project list is built from what is actually in them.

Deliberately prints shape and quality facts BEFORE any conclusions, because the previous
session's lesson was that a claim about data is worthless unless it came from reading the data.

Run: python scripts/.profile-csv.py <csv> [<csv> ...]
"""

import sys
import pandas as pd

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 60)


def profile(path: str) -> None:
    print("=" * 78)
    print(path)
    print("=" * 78)

    df = pd.read_csv(path, low_memory=False)
    print(f"rows: {len(df):,}   columns: {df.shape[1]}")

    # Which fields actually carry signal? A field that is empty everywhere is noise in the
    # header and must not be presented as if it were a usable dimension.
    print("\n-- field fill rate (non-empty share), lowest 25 --")
    fill = (df.notna().sum() / len(df) * 100).round(1).sort_values()
    for name, pct in fill.head(25).items():
        print(f"   {pct:6.1f}%  {name}")
    print("\n-- field fill rate, highest 15 --")
    for name, pct in fill.tail(15).sort_values(ascending=False).items():
        print(f"   {pct:6.1f}%  {name}")

    # dataType tells us posts vs comments, which changes how rows should be read.
    if "dataType" in df.columns:
        print("\n-- dataType --")
        print(df["dataType"].value_counts(dropna=False).to_string())

    for col in ("communityName", "subredditName"):
        if col in df.columns:
            vc = df[col].dropna().astype(str).value_counts()
            print(f"\n-- top 20 by {col} (of {vc.size:,} distinct) --")
            for name, n in vc.head(20).items():
                print(f"   {n:6,}  {name}")
            break

    # Engagement, which is the only defensible basis for a priority ordering.
    for col in ("score", "upVotes", "commentUpVotes", "engagementTotal", "commentsCount"):
        if col in df.columns:
            s = pd.to_numeric(df[col], errors="coerce")
            print(f"\n-- {col} --")
            print(s.describe().round(2).to_string())
            print(f"   zeros: {(s == 0).sum():,}   >0: {(s > 0).sum():,}   max: {s.max()}")

    if "ageHours" in df.columns:
        a = pd.to_numeric(df["ageHours"], errors="coerce")
        print("\n-- ageHours --")
        print(a.describe().round(2).to_string())

    for col in ("title", "body"):
        if col in df.columns:
            s = df[col].dropna().astype(str)
            s = s[s.str.strip() != ""]
            print(f"\n-- {col}: {len(s):,} non-empty --")
            print(f"   mean words: {s.str.split().str.len().mean():.1f}")
            print(f"   longest: {s.str.split().str.len().max():,}")
            print("   samples:")
            for t in s.sample(min(5, len(s)), random_state=7).tolist():
                one = " ".join(str(t).split())[:220]
                print(f"     - {one}")
    print()


if __name__ == "__main__":
    for p in sys.argv[1:]:
        profile(p)
