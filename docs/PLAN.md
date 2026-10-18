# VoterHelp plan: King County, Nov 3 2026 general

Goal: a free, shareable static site where a King County voter enters an address and sees
every race on their ballot, with each candidate's own words and sources. Ship a usable
v1 within days, then add to it.

## Status
- v1 built: address lookup + every King County contest, with candidate statements and measure arguments.
- Key find: the WA SOS online voters' guide has a JSON API (`voter.votewa.gov/elections/*.ashx`) that
  covers every race in the county, including local races and measures. It replaces the King County pamphlet scraper.
- No human review step, so stances (v2) will be verbatim quotes only, tagged by issue, never paraphrased.

## Principles
- Sourced facts only. Every claim links to its source. If we find nothing, say "No stated position".
- Free sources first. Each source gets its own importer, so a paid one (Ballotpedia, BallotReady, Cicero) can be added later without a rewrite.
- Static site. Data is built ahead of time into JSON and the address lookup runs in the browser, so there is no server to run.
- Open Civic Data IDs for districts and contests, so other counties and states fit later.

## Data sources (all free and public)
| Need | Source | How |
|---|---|---|
| Address → lat/long | King County ArcGIS geocoder, Census geocoder as fallback | Browser call |
| Lat/long → districts | King County GIS open data (congressional, legislative, council, judicial, school, fire, etc.) | Download GeoJSON at build time, match the point in the browser |
| Races + candidates | WA SOS candidate filings, King County Elections candidate list | Importer (CSV/download) |
| Candidate statements, photos, contact info | WA SOS online voters' guide (state, federal, legislative, judicial), King County local voters' pamphlet | Scraper |
| Ballot measures | King County pamphlet: ballot title, explanatory statement, pro/con | Scraper |
| Money | WA PDC open data (data.wa.gov) | Importer (Socrata API) |
| Stances | Pamphlet statements, candidate websites | Claude extraction → human review |
| Voting record | Open States (legislature) | Later |

### Scraping rules
- Only official government pages and candidates' own campaign sites. Respect robots.txt, rate-limit, cache raw pages in `data/raw/` with fetch date.
- Don't scrape Ballotpedia, Vote411 or news sites (their terms forbid it, or the content is copyrighted). Link to them instead.
- Store the source URL and retrieval date on every record.

## Data model
`contest` (OCD id, office, district, type) → `candidate` (name, party preference, statement, links)
→ `stance` (issue, summary, verbatim quote, source id, reviewed flag) → `source` (url, title, fetched_at).
Ballot measures are contests with `yes/no` options.

## Milestones
**v1: "My ballot"** (target: ~Oct 23)
- Address box → list of contests, most local first.
- Each candidate: official statement, photo, website, link to the official guide.
- Ballot measures with the official explanatory statement and pro/con.
- Banner: ballot return deadline, drop box finder link, official sources.

**v2: "Issues"** (target: ~Oct 27)
- 2–3 issue chips (taxes/budget, housing/homelessness, public safety, transportation, environment, schools, growth/zoning).
- For each race, each candidate's stance on the chosen issues, with a quote and source link. Shown only after human review.

**v3: "Follow the money"** (if time allows before Nov 3)
- PDC totals raised, top donors, independent expenditures for/against.

**Later**
- Per-issue placement on a spectrum, with evidence (only if we decide to).
- Incumbent voting records. Other WA counties, then Ballotpedia for nationwide.

## Stack
- `pipeline/` (Python): one importer/scraper per source → normalized JSON in `site/data/`.
- `site/` (static HTML/JS, no framework at first): address lookup, point-in-polygon, rendering.
- Hosting: GitHub Pages. A GitHub Action re-runs the pipeline daily until the election.
