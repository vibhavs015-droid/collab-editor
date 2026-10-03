# ADR template

Copy this file to `NNNN-short-kebab-title.md` with the next sequence number, then
fill in every section.

---

# NNNN — Title stating the decision, not the topic

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD
**Phase:** N

## Context

What forces are in play? What constraints exist? What problem are we solving?

State the facts that make the decision necessary. If you cannot articulate what
made a decision hard, there was no decision to make.

## Decision

The choice, stated plainly in the active voice: "We will X."

## Rationale

Why this option over the others. Be specific about the property that made it win.

If this choice optimises for something — clarity over cleverness, correctness over
speed, interview legibility over theoretical purity — say so explicitly. An
unstated optimisation target is invisible to the reader.

## Consequences

**Good**

- Concrete, verifiable benefits

**Bad**

- Costs, risks, and things that get harder. Mandatory. An ADR with only upsides
  is advocacy.

## Alternatives rejected

| Option | Why rejected                                            |
| ------ | ------------------------------------------------------- |
| ...    | The specific disqualifying flaw, not a vague dismissal. |

## Revisit if

The conditions that would invalidate this decision. A decision with no stated
invalidation condition has not been thought through.
