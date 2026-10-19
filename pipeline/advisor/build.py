"""Check advisor briefs against their sources and publish them to site/data/advisor.json.

Every evidence quote must appear verbatim (after normalizing whitespace and punctuation) in its
source: the candidate's voters' guide statement, their scraped campaign website, or the page at
its url (fetched and cached in data/raw/advisor_web/). Evidence that fails is dropped, and a
position with no evidence left is dropped too. Unknown issue/option/candidate ids are errors.

Usage: python build.py [--refresh]
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / "site" / "data"
CACHE = ROOT / "data" / "raw" / "advisor_web"
GUIDE_URL = "voter.votewa.gov/genericvoterguide.aspx"
UA = "VoterHelp/0.1 (nonpartisan voter guide; github.com/roshank/VoterHelp)"

session = requests.Session()
session.headers["User-Agent"] = UA


def norm(text):
    text = unicodedata.normalize("NFKC", text or "")
    text = (text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
            .replace("–", "-").replace("—", "-").replace(" ", " "))
    text = re.sub(r"\s+", " ", text)
    return text.strip().lower()


def page_text(url):
    """Visible text of a web page, fetched once and cached. Falls back to a headless render."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(url.encode()).hexdigest()
    cached = CACHE / f"{key}.txt"
    if cached.exists() and "--refresh" not in sys.argv:
        return cached.read_text()
    text = ""
    try:
        resp = session.get(url, timeout=30)
        if resp.ok:
            text = BeautifulSoup(resp.text, "html.parser").get_text(" ")
    except requests.RequestException:
        pass
    renderer = ROOT / "pipeline" / "render_js.mjs"
    if len(text) < 2000 and shutil.which("node") and renderer.exists():
        proc = subprocess.run(["node", str(renderer), url], capture_output=True, text=True, timeout=90)
        if proc.returncode == 0 and (html := json.loads(proc.stdout).get(url)):
            text = BeautifulSoup(html, "html.parser").get_text(" ")
    cached.write_text(text)
    return text


def main():
    questions = json.loads((HERE / "questions.json").read_text())["issues"]
    options = {i: {o["id"] for q in qs for o in q["options"]} for i, qs in questions.items()}
    ballot = json.loads((DATA / "ballot.json").read_text())
    websites = json.loads((DATA / "websites.json").read_text())["candidates"]
    contests = {c["id"]: c for c in ballot["contests"]}

    races, report = {}, []
    for path in sorted((HERE / "briefs").glob("*.json")):
        brief = json.loads(path.read_text())
        contest = contests.get(brief["contest_id"])
        if not contest:
            sys.exit(f"{path.name}: unknown contest {brief['contest_id']}")
        cands = {c["id"]: c for c in contest["candidates"]}
        own_text = {
            cid: {
                "guide": norm(" ".join(p for s in c.get("statement", []) for p in s["paragraphs"])),
                "site": norm(" ".join(p for pg in websites.get(cid, {}).get("pages", []) for p in pg["paragraphs"])),
            } for cid, c in cands.items()
        }
        kept = dropped = 0

        def verified(cid, ev):
            q = norm(ev.get("quote"))
            if len(q) < 8:
                return False
            if GUIDE_URL in ev.get("url", ""):
                return q in own_text[cid]["guide"]
            if q in own_text[cid]["site"]:
                return True
            return q in norm(page_text(ev["url"]))

        for cid in brief.get("candidates", {}):
            if cid not in cands:
                sys.exit(f"{path.name}: unknown candidate {cid}")
        for issue_id, issue in list(brief.get("issues", {}).items()):
            if issue_id not in questions:
                sys.exit(f"{path.name}: unknown issue {issue_id}")
            for cid, positions in list(issue.get("positions", {}).items()):
                if cid not in cands:
                    sys.exit(f"{path.name}: unknown candidate {cid}")
                for opt, pos in list(positions.items()):
                    if opt not in options[issue_id]:
                        sys.exit(f"{path.name}: unknown option {issue_id}.{opt}")
                    if pos.get("stance") not in ("supports", "opposes"):
                        sys.exit(f"{path.name}: bad stance for {cid} {opt}")
                    good = []
                    for ev in pos.get("evidence", []):
                        if verified(cid, ev):
                            good.append(ev)
                            kept += 1
                        else:
                            dropped += 1
                            report.append(f"  dropped [{path.stem} {cands[cid]['name']} {opt}] {ev.get('url')} :: {ev.get('quote', '')[:80]}")
                    if good:
                        pos["evidence"] = good
                    else:
                        del positions[opt]
                if not positions:
                    del issue["positions"][cid]
            if not issue.get("positions"):
                del brief["issues"][issue_id]
        races[brief["contest_id"]] = brief
        print(f"{path.stem}: {kept} quotes verified, {dropped} dropped")

    out = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "questions": questions, "races": races}
    (DATA / "advisor.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"wrote {len(races)} race briefs to site/data/advisor.json")
    print("\n".join(report))


if __name__ == "__main__":
    main()
