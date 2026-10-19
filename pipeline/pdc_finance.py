"""Import campaign finance data from the WA Public Disclosure Commission (PDC).

Uses PDC open data on data.wa.gov (Socrata):
  3h9x-7bvm  Campaign Finance Summary (one row per candidacy: raised, spent, debt)
  kv7h-kjye  Contributions to Candidates and Political Committees (itemized)
  67cp-h962  Independent Campaign Expenditures and Electioneering Communications

Matches each state/local candidate in site/data/ballot.json to their PDC committee and
writes site/data/finance.json. Federal candidates file with the FEC, not the PDC, so they
get a link to FEC data instead.
"""
import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "pdc"
OUT = ROOT / "site" / "data"
SODA = "https://data.wa.gov/resource"
YEAR = "2026"
TOP_DONORS = 5

session = requests.Session()
session.headers["User-Agent"] = "VoterHelp/0.1 (nonpartisan voter guide; github.com/roshank/VoterHelp)"


def soda(dataset, params, raw_name):
    cache = RAW / raw_name
    if cache.exists() and "--refresh" not in sys.argv:
        return json.loads(cache.read_text())
    rows, offset = [], 0
    while True:
        resp = session.get(f"{SODA}/{dataset}.json", params={**params, "$limit": 50000, "$offset": offset}, timeout=180)
        resp.raise_for_status()
        page = resp.json()
        rows += page
        if len(page) < 50000:
            break
        offset += 50000
    cache.write_text(json.dumps(rows))
    return rows


def name_tokens(name):
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    name = re.sub(r"['\"“”‘’].*?['\"“”‘’]", " ", name)  # nicknames in quotes
    name = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", " ", name)
    return [t for t in re.split(r"[^a-z\-]+", name) if len(t) > 1]


def filer_names(row):
    """PDC names look like "Anita M. Crawford-Willis (Anita Crawford-Willis)": legal name (ballot name)."""
    full = row["filer_name"]
    names = [name_tokens(re.sub(r"\(.*\)", "", full))]
    if m := re.search(r"\((.*)\)", full):
        names.append(name_tokens(m.group(1)))
    return [n for n in names if n]


def match_score(cand_tokens, row):
    first, last = cand_tokens[0], cand_tokens[-1]
    best = 0
    for n in filer_names(row):
        if n[-1] != last:
            continue
        if n[0] == first:
            best = max(best, 3)
        elif n[0][0] == first[0]:
            best = max(best, 1)
    return best


# PDC reporting lines that aren't a donor.
NOT_DONORS = {"SMALL CONTRIBUTIONS", "MISCELLANEOUS RECEIPTS"}


def bucket(row):
    """Plain-language source of a contribution row."""
    name, code = row["contributor_name"].strip().upper(), row["code"]
    if name == "SMALL CONTRIBUTIONS":
        return "Small or unitemized contributions"
    if code == "Self":
        return "The candidate"
    if row["contributor_category"] == "Individual":
        return "Individuals"
    return {
        "Political Action Committee": "PACs and political committees",
        "Caucus": "PACs and political committees",
        "Party": "Political parties",
        "Business": "Businesses",
        "Union": "Unions",
    }.get(code, "Other organizations")


def money(v):
    try:
        return round(float(v or 0), 2)
    except ValueError:
        return 0.0


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    ballot = json.loads((OUT / "ballot.json").read_text())
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    summaries = soda("3h9x-7bvm", {"$where": f"election_year='{YEAR}' AND on_general_election_ballot=true"},
                     "summary.json")
    summaries = [r for r in summaries if "(write-in)" not in r["filer_name"].lower()]

    # 1. Match ballot candidates to PDC candidacies.
    matched, federal, unmatched = {}, [], []
    for contest in ballot["contests"]:
        for cand in contest.get("candidates", []):
            if contest["category"] == "FED":
                federal.append(cand)
                continue
            tokens = name_tokens(cand["name"])
            scored = sorted(((match_score(tokens, r), r) for r in summaries), key=lambda x: -x[0])
            scored = [s for s in scored if s[0] > 0]
            # Prefer a King County or state-level jurisdiction when two filers share a name.
            scored.sort(key=lambda s: (-s[0], s[1].get("jurisdiction_county") not in ("KING", None)))
            if scored:
                matched[cand["id"]] = scored[0][1]
            else:
                unmatched.append(cand["name"])

    committee_ids = sorted({r["committee_id"] for r in matched.values() if r.get("committee_id")})
    id_list = ",".join(f"'{c}'" for c in committee_ids)

    # 2. Contributions, grouped by donor, for matched committees only.
    contribs = soda("kv7h-kjye", {
        "$select": "committee_id, contributor_name, contributor_category, code, sum(amount) as total, count(*) as n",
        "$where": f"election_year='{YEAR}' AND committee_id in ({id_list})",
        "$group": "committee_id, contributor_name, contributor_category, code",
    }, "contributions.json")
    by_committee = defaultdict(list)
    for row in contribs:
        by_committee[row["committee_id"]].append(row)

    # 3. Independent expenditures and electioneering for/against matched candidates.
    ies = soda("67cp-h962", {
        "$select": "candidate_committee_id, sponsor_name, for_or_against, sum(portion_of_amount) as total",
        "$where": f"election_year='{YEAR}' AND candidate_committee_id in ({id_list})",
        "$group": "candidate_committee_id, sponsor_name, for_or_against",
    }, "independent_expenditures.json")
    ie_by_committee = defaultdict(list)
    for row in ies:
        ie_by_committee[row["candidate_committee_id"]].append(row)

    out = {"generated_at": fetched_at, "source": "https://www.pdc.wa.gov/political-disclosure-reporting-data/open-data",
           "candidates": {}}
    for cand_id, s in matched.items():
        cid = s.get("committee_id")
        if not cid:
            # Declared a candidacy but registered no campaign committee (typically raising little or no money).
            out["candidates"][cand_id] = {"pdc_name": s["filer_name"], "no_committee": True}
            continue
        rows = by_committee.get(cid, [])
        by_type = defaultdict(float)
        for r in rows:
            by_type[bucket(r)] += money(r["total"])
        # Name organizations (PACs, businesses, unions, parties). Individual donors are public record on
        # the PDC site, but we only show their combined total here.
        orgs = defaultdict(lambda: {"total": 0.0, "type": ""})
        for r in rows:
            if r["contributor_category"] == "Organization" and r["contributor_name"].strip().upper() not in NOT_DONORS:
                o = orgs[r["contributor_name"].strip()]
                o["total"] += money(r["total"])
                o["type"] = r["code"]
        top_orgs = sorted(({"name": k, **v} for k, v in orgs.items()), key=lambda o: -o["total"])[:TOP_DONORS]
        individuals = [r for r in rows if bucket(r) == "Individuals"]
        support = defaultdict(float)
        oppose = defaultdict(float)
        for r in ie_by_committee.get(cid, []):
            target = support if (r.get("for_or_against") or "").lower().startswith("for") else oppose
            target[r["sponsor_name"].strip()] += money(r["total"])
        top = lambda d: sorted(({"name": k, "total": round(v, 2)} for k, v in d.items() if v > 0), key=lambda x: -x["total"])
        out["candidates"][cand_id] = {
            "pdc_name": s["filer_name"],
            "pdc_url": (s.get("url") or {}).get("url"),
            "raised": money(s.get("contributions_amount")),
            "carried_forward": money(s.get("carryforward_amount")),
            "spent": money(s.get("expenditures_amount")),
            "debt": money(s.get("debts_amount")),
            "loans": money(s.get("loans_amount")),
            "by_type": {k: round(v, 2) for k, v in sorted(by_type.items(), key=lambda kv: -kv[1])},
            "individual_donors": len({r["contributor_name"].strip().lower() for r in individuals}),
            "top_organizations": [{**o, "total": round(o["total"], 2)} for o in top_orgs],
            "outside_support": top(support),
            "outside_opposition": top(oppose),
        }
    for cand in federal:
        out["candidates"][cand["id"]] = {
            "federal": True,
            "fec_url": f"https://www.fec.gov/data/candidates/?q={quote_plus(cand['name'])}&election_year={YEAR}",
        }
    (OUT / "finance.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"{len(matched)} candidates matched to PDC, {len(federal)} federal (FEC link), "
          f"{len(contribs)} donor rows, {len(ies)} outside-spending rows")
    for name in unmatched:
        print("  - no PDC match:", name)


if __name__ == "__main__":
    main()
