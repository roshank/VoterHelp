"""Scrape candidates' own campaign websites for their stated positions.

Reads candidate websites from site/data/ballot.json (as listed in the official voters' guide),
fetches the home page plus a few same-site pages that look like issues/priorities/about pages,
and writes plain-text paragraphs to site/data/websites.json. Respects robots.txt.
Raw HTML is cached in data/raw/web/ (pass --refresh to re-download).
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup, Comment

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "web"
OUT = ROOT / "site" / "data"
UA = "VoterHelp/0.1 (nonpartisan voter guide; github.com/roshank/VoterHelp)"
MAX_PAGES = 6  # home page + up to 5 linked pages per site
MIN_PARA = 40  # shorter text is usually navigation, buttons or footers

# Link text/paths that usually hold a candidate's positions, best first.
LINK_HINTS = ["issue", "priorit", "platform", "plan", "policy", "policies", "position", "agenda",
              "vision", "values", "where-i-stand", "why", "about", "meet", "bio"]
SKIP_HINTS = ["donat", "contribut", "volunteer", "event", "contact", "endorse", "news", "press", "blog",
              "shop", "store", "privacy", "login", "signup", "sign-up", "join", "calendar", "lawn-sign",
              "yard-sign", "mailto:", "tel:", "facebook", "twitter", "instagram", "x.com", "linkedin",
              "actblue", "winred", "youtube", "tiktok", ".pdf", ".jpg", ".png", "espanol", "/es/"]
BOILERPLATE = re.compile(r"paid for by|all rights reserved|copyright|©|cookie|javascript|subscribe|lorem ipsum|"
                         r"sign up|newsletter|powered by|privacy policy|skip to", re.I)

session = requests.Session()
session.headers["User-Agent"] = UA


def cache_path(url, rendered=False):
    return RAW / (hashlib.sha1(url.encode()).hexdigest() + (".rendered" if rendered else "") + ".html")


def render(urls):
    """Render JavaScript-only pages with headless Chromium (render_js.mjs). Needs node + playwright."""
    todo = [u for u in urls if "--refresh" in sys.argv or not cache_path(u, True).exists()]
    if todo and shutil.which("node"):
        proc = subprocess.run(["node", str(Path(__file__).with_name("render_js.mjs")), *todo],
                              capture_output=True, text=True, timeout=60 * len(todo))
        if proc.returncode == 0:
            for url, html in json.loads(proc.stdout).items():
                if html:
                    cache_path(url, True).write_text(html)
    return {u: cache_path(u, True).read_text(errors="replace") for u in urls if cache_path(u, True).exists()}


def fetch(url):
    cache = cache_path(url)
    if cache.exists() and "--refresh" not in sys.argv:
        return cache.read_text(errors="replace"), None
    try:
        resp = session.get(url, timeout=20, allow_redirects=True)
    except requests.RequestException as e:
        return None, type(e).__name__
    if resp.status_code != 200 or "html" not in resp.headers.get("content-type", ""):
        return None, f"HTTP {resp.status_code}"
    cache.write_text(resp.text)
    time.sleep(1)  # be polite: at most ~1 request/second per site
    return resp.text, None


def robots_for(url):
    rp = RobotFileParser()
    try:
        resp = session.get(urljoin(url, "/robots.txt"), timeout=10)
        rp.parse(resp.text.splitlines() if resp.status_code == 200 else [])
    except requests.RequestException:
        rp.parse([])
    return rp


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def extract(html):
    soup = BeautifulSoup(html, "html.parser")
    title = clean(soup.title.get_text()) if soup.title else ""
    for tag in soup(["script", "style", "noscript", "nav", "footer", "header", "form", "svg", "iframe"]):
        tag.decompose()
    for c in soup.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()
    paras = []
    for el in soup.find_all(["p", "li", "h2", "h3", "blockquote"]):
        if el.find(["p", "li"]):  # keep the innermost block only
            continue
        text = clean(el.get_text(" "))
        if len(text) >= MIN_PARA and not BOILERPLATE.search(text):
            paras.append(text)
    return title, paras


def same_site(a, b):
    strip = lambda h: h.lower().removeprefix("www.")
    return strip(urlparse(a).netloc) == strip(urlparse(b).netloc)


def candidate_links(html, base):
    soup = BeautifulSoup(html, "html.parser")
    scored = {}
    for a in soup.find_all("a", href=True):
        url = urldefrag(urljoin(base, a["href"]))[0].rstrip("/")
        if not url.startswith("http") or not same_site(url, base) or url == base.rstrip("/"):
            continue
        key = (url + " " + a.get_text(" ")).lower()
        if any(s in key for s in SKIP_HINTS):
            continue
        rank = next((i for i, hint in enumerate(LINK_HINTS) if hint in key), None)
        if rank is not None:
            scored[url] = min(rank, scored.get(url, 99))
    return [u for u, _ in sorted(scored.items(), key=lambda kv: kv[1])]


def scrape(candidate, rendered=False):
    start = candidate["website"]
    result = {"website": start, "pages": [], "error": None}
    html, err = (render([start]).get(start), "render failed") if rendered else fetch(start)
    if html is None:
        result["error"] = err
        return result
    robots = robots_for(start)
    if not robots.can_fetch(UA, start):
        result["error"] = "robots.txt disallows"
        return result
    queue = [start] + candidate_links(html, start)[: MAX_PAGES - 1]
    pages = render(queue[1:]) if rendered else {}
    seen_text = set()
    for url in queue:
        if url != start and not robots.can_fetch(UA, url):
            continue
        page_html = html if url == start else (pages.get(url) if rendered else fetch(url)[0])
        if not page_html:
            continue
        title, paras = extract(page_html)
        fresh = [p for p in paras if p not in seen_text]  # drop text repeated across pages
        seen_text.update(fresh)
        if fresh:
            result["pages"].append({"url": url, "title": title, "paragraphs": fresh})
    if not result["pages"]:
        result["error"] = "no readable text (site may need JavaScript)"
        if not rendered:
            return scrape(candidate, rendered=True)
    result["rendered"] = rendered
    return result


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    ballot = json.loads((OUT / "ballot.json").read_text())
    candidates = [c for contest in ballot["contests"] for c in contest.get("candidates", []) if c.get("website")]
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with ThreadPoolExecutor(max_workers=12) as pool:  # different sites in parallel, each site sequential
        results = list(pool.map(scrape, candidates))
    out = {"generated_at": fetched_at, "candidates": {}}
    for cand, res in zip(candidates, results):
        res["fetched_at"] = fetched_at
        out["candidates"][cand["id"]] = res
    (OUT / "websites.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))

    ok = [r for r in results if r["pages"]]
    print(f"{len(ok)}/{len(candidates)} candidate sites scraped, "
          f"{sum(len(p['paragraphs']) for r in ok for p in r['pages'])} paragraphs")
    for cand, res in zip(candidates, results):
        if res["error"]:
            print(f"  - {cand['name']}: {res['website']} ({res['error']})")


if __name__ == "__main__":
    main()
