"""Triage a Slither JSON report by severity.

Usage: python triage_slither.py security/slither-report.json

Groups findings by impact, prints the High/Medium ones in full so they can be
fixed or justified one by one, and writes a summary markdown table.
"""
import json
import sys
from collections import Counter

IMPACT_ORDER = {"High": 0, "Medium": 1, "Low": 2, "Informational": 3, "Optimization": 4}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python triage_slither.py <slither-report.json>")
        return 2

    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        report = json.load(fh)

    detectors = report.get("results", {}).get("detectors", [])
    if not detectors:
        print("No findings in report.")
        return 0

    by_impact = Counter(d["impact"] for d in detectors)
    print(f"Total findings: {len(detectors)}")
    for impact, count in sorted(by_impact.items(), key=lambda kv: IMPACT_ORDER.get(kv[0], 9)):
        print(f"  {impact:<15} {count}")

    # High and Medium are the findings that require a decision.
    actionable = [d for d in detectors if d["impact"] in ("High", "Medium")]
    print(f"\nActionable (High + Medium): {len(actionable)}\n")
    for d in sorted(actionable, key=lambda x: IMPACT_ORDER[x["impact"]]):
        print(f"[{d['impact']}] {d['check']}")
        first = d["description"].strip().split("\n")[0]
        print(f"    {first[:220]}")
        print()

    counts = Counter(d["check"] for d in actionable)
    print("Actionable detectors by type:")
    for check, n in counts.most_common():
        print(f"  {check}: {n}")

    # Emit a compact markdown table for the security write-up.
    lines = ["| Impact | Detector | Count |", "|---|---|---|"]
    for check, n in sorted(
        Counter(d["check"] for d in detectors).items(),
        key=lambda kv: -kv[1],
    ):
        impacts = {d["impact"] for d in detectors if d["check"] == check}
        worst = min(impacts, key=lambda i: IMPACT_ORDER.get(i, 9))
        lines.append(f"| {worst} | `{check}` | {n} |")

    out = "security/slither-summary.md"
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("# Slither summary\n\n")
        fh.write(f"Total findings: {len(detectors)}\n\n")
        fh.write("\n".join(lines))
        fh.write("\n")
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())