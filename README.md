# VoterHelp

A free, nonpartisan, static voter guide. Enter an address and see every race on your
ballot, in the candidates' own words, with links to official sources.

Current coverage: **King County, WA, November 3, 2026 general election.**

## How it works
- `pipeline/sos_guide.py` pulls the WA Secretary of State online voters' guide (candidate
  statements, photos, contact info, ballot measure text and pro/con arguments) and writes
  `site/data/ballot.json` plus `site/data/photos/`.
- `pipeline/districts.py` tags each contest with the King County GIS district it belongs to.
- `site/` is plain HTML/JS. In the browser, the address is geocoded with King County's public
  locator, and the King County district layers are queried at that point to pick the contests.
- `.github/workflows/site.yml` deploys `site/` to GitHub Pages on every push to `main`,
  and refreshes the data daily.

## Run locally
```sh
pip install -r pipeline/requirements.txt
cd pipeline && python sos_guide.py            # add --refresh to re-download
cd ../site && python -m http.server 8000      # open http://localhost:8000
```

See `docs/PLAN.md` for the roadmap.
