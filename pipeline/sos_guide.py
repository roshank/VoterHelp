"""Import the WA Secretary of State online voters' guide for one county.

Source: https://voter.votewa.gov/genericvoterguide.aspx (the JSON API behind it).
Writes raw responses to data/raw/sos/ and normalized output to site/data/.
"""
import base64
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup, Comment, Doctype
from PIL import Image, ImageOps

from districts import display_title, match_for

API = "https://voter.votewa.gov/elections"
GUIDE_URL = "https://voter.votewa.gov/genericvoterguide.aspx?e={e}&c={c}"
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "sos"
OUT = ROOT / "site" / "data"

session = requests.Session()
session.headers["User-Agent"] = "VoterHelp/0.1 (nonpartisan voter guide; github.com/roshank/VoterHelp)"


def get_json(endpoint, params, raw_name):
    cache = RAW / raw_name
    if cache.exists() and "--refresh" not in sys.argv:
        return json.loads(cache.read_text())
    resp = session.get(f"{API}/{endpoint}", params=params, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    cache.write_text(json.dumps(data, indent=1))
    time.sleep(0.5)  # be polite
    return data


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


LABELS = ("Elected Experience|Other Professional Experience|Professional Experience|Legal/Judicial Experience|"
          "Education|Occupation|Community Service|Statement|Endorsed by")
LABEL_LINE = re.compile(rf"^@@({LABELS})@@$", re.I)
LABEL_PREFIX = re.compile(rf"^({LABELS})\s*:\s*", re.I)


def html_paragraphs(html, mark_labels=False):
    """Flatten guide HTML (often malformed fragments) into plain-text paragraphs.

    No markup reaches the site. With mark_labels, bold section headings such as
    "Education" become "@@Education@@" lines so statement_sections can split on them.
    """
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    for junk in soup.find_all(string=lambda t: isinstance(t, (Doctype, Comment))):
        junk.extract()
    for s in soup.find_all(string=True):
        s.replace_with(re.sub(r"\s+", " ", s))
    if mark_labels:
        for tag in soup.find_all(["b", "strong"]):
            m = re.fullmatch(rf"\s*({LABELS})\s*:?\s*", tag.get_text(), re.I)
            if m:
                tag.replace_with(f"\n@@{m.group(1)}@@\n")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for block in soup.find_all(["p", "li", "div", "h1", "h2", "h3", "h4", "tr"]):
        block.insert_after("\n")
    for junk in soup.find_all(["style", "script", "title", "head"]):
        junk.decompose()
    return [line for line in (clean(l) for l in soup.get_text().split("\n")) if line]


def statement_sections(html):
    """Split a candidate statement into labeled sections, e.g. Education / Statement / Endorsed by."""
    sections = []
    for para in html_paragraphs(html, mark_labels=True):
        m = LABEL_LINE.match(para) or LABEL_PREFIX.match(para)
        if m:
            label = m.group(1).strip()
            sections.append({"label": label[0].upper() + label[1:].lower(), "paragraphs": []})
            para = para[m.end():]
        elif not sections:
            sections.append({"label": "Statement", "paragraphs": []})
        if para:
            sections[-1]["paragraphs"].append(para)
    return [s for s in sections if s["paragraphs"]]


def save_photo(data, path, width=240):
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img.save(path, "JPEG", quality=80, optimize=True)


def tidy_case(text):
    """"CITY OF SEATTLE" -> "City of Seattle"; leaves mixed-case text alone."""
    if text != text.upper():
        return text
    small = {"of", "the", "and", "no."}
    return " ".join(w.lower() if w.lower() in small and i else w.capitalize()
                    for i, w in enumerate(text.split())).replace("Seatac", "SeaTac")


def website(url):
    url = clean(url)
    if url and not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url or None


def build(election_id, county_code):
    RAW.mkdir(parents=True, exist_ok=True)
    (OUT / "photos").mkdir(parents=True, exist_ok=True)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    guide_url = GUIDE_URL.format(e=election_id, c=county_code)
    guide = get_json("voterguide.ashx", {"e": election_id, "la": "en", "c": county_code, "p": "XX"},
                     f"guide-{election_id}-{county_code}.json")

    contests, unmatched = [], []
    for category in guide["Categories"]:
        for race in category["Races"]:
            rid = race["RaceID"]
            contest = {
                "id": f"sos-{election_id}-{rid}",
                "category": category["CategoryCode"],
                "title": clean(race["Name"]),
                "jurisdiction": clean(race["Jurisdiction"]),
                "term": clean(race.get("TermFullLabel")),
                "source": {"name": "WA Secretary of State voters' guide", "url": guide_url,
                           "fetched_at": fetched_at},
            }
            if category["CategoryCode"] == "MEA":
                m = get_json("measure.ashx", {"m": rid, "e": election_id, "la": "en", "c": county_code},
                             f"measure-{rid}.json")
                contest.update({
                    "type": "measure",
                    "jurisdiction": tidy_case(clean(m.get("Jurisdiction")) or contest["jurisdiction"]),
                    "short_description": clean(m.get("ShortDescription") or race.get("ShortDescription")),
                    "ballot_title": html_paragraphs(m.get("BallotTitle")),
                    "explanatory_statement": html_paragraphs(m.get("ExplanatoryStatement")),
                    "fiscal_statement": html_paragraphs(m.get("FiscalStatement")),
                    "argument_for": html_paragraphs(m.get("ArgumentFor")),
                    "argument_against": html_paragraphs(m.get("ArgumentAgainst")),
                    # RebuttalFor rebuts the argument for, so opponents write it (and vice versa).
                    "rebuttal_by_opponents": html_paragraphs(m.get("RebuttalFor")),
                    "rebuttal_by_proponents": html_paragraphs(m.get("RebuttalAgainst")),
                    "committee_for": " ".join(html_paragraphs(m.get("CommitteeFor"))),
                    "committee_against": " ".join(html_paragraphs(m.get("CommitteeAgainst"))),
                    "full_text_url": website(m.get("FullTextURL")),
                    "options": [race.get("TextFor") or "Yes", race.get("TextAgainst") or "No"],
                })
            else:
                profiles = get_json("candidate.ashx",
                                    {"e": election_id, "r": rid, "b": "0", "la": "en", "c": county_code},
                                    f"candidates-{rid}.json")
                candidates = []
                for p in sorted((p["statement"] for p in profiles), key=lambda s: int(s["BallotDisplayOrder"])):
                    bid = p["BallotID"]
                    photo = None
                    if p.get("Photo"):
                        photo = f"photos/{bid}.jpg"
                        save_photo(base64.b64decode(p["Photo"]), OUT / photo)
                    candidates.append({
                        "id": f"sos-{bid}",
                        "name": clean(p["BallotName"]),
                        "party": clean(p.get("PartyName")) or None,
                        "photo": photo,
                        "website": website(p.get("OrgWebsite")),
                        "email": clean(p.get("OrgEmail")) or None,
                        "phone": clean(p.get("OrgPhone")) or None,
                        "statement": statement_sections(p.get("Statement")),
                    })
                contest.update({
                    "type": "candidate",
                    "partisan": any(c["party"] for c in candidates),
                    "candidates": candidates,
                })
                if race.get("TermFullLabel") is None or not contest["term"]:
                    contest["term"] = clean(profiles[0]["statement"].get("TermFullLabel")) if profiles else ""
            contest["match"] = match_for(contest)
            contest["title"], contest["jurisdiction"] = display_title(contest)
            if contest["match"] is None:
                unmatched.append(contest["title"] + " / " + contest["jurisdiction"])
            contests.append(contest)

    out = {
        "election": {"id": election_id, "name": "General Election", "date": "2026-11-03",
                     "county": "King"},
        "generated_at": fetched_at,
        "contests": contests,
    }
    (OUT / "ballot.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"{len(contests)} contests, "
          f"{sum(len(c.get('candidates', [])) for c in contests)} candidates")
    if unmatched:
        print("Contests with no district rule (shown to everyone as 'may be on your ballot'):")
        for u in unmatched:
            print("  -", u)


if __name__ == "__main__":
    build(election_id="899", county_code="17")
