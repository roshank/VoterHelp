"""Write one evidence bundle per contest for the advisor research step.

Each bundle (data/advisor/bundles/<contest id>.md) holds everything we already have on the
candidates: voters' guide statement, campaign website text, endorsements, and PDC money.
Researchers read the bundle, add public sources (records, interviews, questionnaires), and
write a brief to pipeline/advisor/briefs/<contest id>.json. See pipeline/advisor/README.md.

Usage: python bundle.py [contest id ...]   (default: every contested, non-judicial race)
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"
OUT = ROOT / "data" / "advisor" / "bundles"
WEBSITE_CHARS = 15000  # per candidate, keeps bundles readable


def is_judicial(contest):
    return contest["category"] == "JUD" or "Judge" in contest["title"]


def advisable(contest):
    return contest["type"] == "candidate" and len(contest["candidates"]) > 1 and not is_judicial(contest)


def usd(n):
    return f"${n:,.0f}"


def candidate_section(cand, websites, finance):
    lines = [f"## {cand['name']}  (id: {cand['id']})", ""]
    if cand.get("party"):
        lines.append(f"Party preference: {cand['party']}")
    if cand.get("website"):
        lines.append(f"Campaign website: {cand['website']}")
    lines.append("")
    lines.append("### Voters' guide statement (source: WA Secretary of State voters' guide)")
    for section in cand.get("statement", []):
        lines.append(f"**{section['label']}:**")
        lines += section["paragraphs"]
        lines.append("")
    site = websites.get(cand["id"], {})
    if site.get("pages"):
        lines.append("### Campaign website text")
        used = 0
        for page in site["pages"]:
            lines.append(f"[page: {page['url']}]")
            for para in page["paragraphs"]:
                if used > WEBSITE_CHARS:
                    break
                lines.append(para)
                used += len(para)
            lines.append("")
    else:
        lines.append(f"### Campaign website text: not available ({site.get('error') or 'no website listed'})")
    f = finance.get(cand["id"], {})
    lines.append("")
    if f.get("federal"):
        lines.append(f"### Money: federal candidate, see FEC: {f['fec_url']}")
    elif f and not f.get("no_committee"):
        lines.append(f"### Money (WA PDC): raised {usd(f['raised'])}, spent {usd(f['spent'])}")
        lines.append("Sources: " + "; ".join(f"{k} {usd(v)}" for k, v in f["by_type"].items()))
        if f["top_organizations"]:
            lines.append("Largest organizational donors: " + "; ".join(f"{o['name']} {usd(o['total'])}" for o in f["top_organizations"]))
        if f["outside_support"]:
            lines.append("Outside spending to support: " + "; ".join(f"{o['name']} {usd(o['total'])}" for o in f["outside_support"]))
        if f["outside_opposition"]:
            lines.append("Outside spending to oppose: " + "; ".join(f"{o['name']} {usd(o['total'])}" for o in f["outside_opposition"]))
    lines.append("")
    return lines


def main():
    ballot = json.loads((DATA / "ballot.json").read_text())
    websites = json.loads((DATA / "websites.json").read_text())["candidates"]
    finance = json.loads((DATA / "finance.json").read_text())["candidates"]
    wanted = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    for contest in ballot["contests"]:
        if not advisable(contest) or (wanted and contest["id"] not in wanted):
            continue
        lines = [f"# {contest['title']} ({contest['jurisdiction']})", f"Contest id: {contest['id']}",
                 f"Term: {contest.get('term') or 'n/a'}", ""]
        for cand in contest["candidates"]:
            lines += candidate_section(cand, websites, finance)
        (OUT / f"{contest['id']}.md").write_text("\n".join(lines))
        n += 1
    print(f"wrote {n} bundles to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
