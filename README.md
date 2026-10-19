# VoterHelp

A free, nonpartisan, static voter guide. Enter an address and see every race on your
ballot, in the candidates' own words, with links to official sources.

Current coverage: **King County, WA, November 3, 2026 general election.**

## How it works
- `pipeline/sos_guide.py` pulls the WA Secretary of State online voters' guide (candidate
  statements, photos, contact info, ballot measure text and pro/con arguments) and writes
  `site/data/ballot.json` plus `site/data/photos/`.
- `pipeline/campaign_sites.py` reads each candidate's campaign website (the one they listed in the
  guide): the home page plus up to 5 issues/priorities/about pages, respecting robots.txt. It writes
  `site/data/websites.json`. JavaScript-only sites are rendered with headless Chromium (`render_js.mjs`).
- `pipeline/pdc_finance.py` matches state and local candidates to their WA Public Disclosure
  Commission filings (data.wa.gov) and writes `site/data/finance.json`: raised/spent, sources of
  money, largest organizational donors, and outside spending for or against. Individual donors are
  only counted and totaled, never named.
- `pipeline/districts.py` tags each contest with the King County GIS district it belongs to.
- `site/` is plain HTML/JS. In the browser, the address is geocoded with King County's public
  locator, and the King County district layers are queried at that point to pick the contests.
- `.github/workflows/site.yml` deploys `site/` to GitHub Pages on every push to `main`,
  and refreshes the voters' guide data daily. Campaign sites are re-scraped by hand.

## Run locally
```sh
pip install -r pipeline/requirements.txt
cd pipeline && python sos_guide.py            # add --refresh to re-download
python pdc_finance.py --refresh
python campaign_sites.py                      # optional: npm install here first for JS-only sites
cd ../site && python -m http.server 8000      # open http://localhost:8000
```

See `docs/PLAN.md` for the roadmap.
