# Advisor briefs

The advisor helps a voter compare candidates on what *they* care about. It is precomputed:
researchers (an LLM in a Claude Code session) write one brief per contested race, and the site
combines the brief with the voter's answers in the browser. Every voter sees the same evidence.

Flow:
1. `python bundle.py` writes `data/advisor/bundles/<contest id>.md`: everything we already have
   (statement, website text, PDC money).
2. A researcher reads the bundle, researches public sources, and writes
   `pipeline/advisor/briefs/<contest id>.json` (schema below).
3. `python build.py` checks every quote against its source, drops anything that fails, and writes
   `site/data/advisor.json`.

## Rules (these are what make it fair)

- **Neutral.** Describe positions; never praise, criticize, or recommend. No adjectives like
  "strong", "extreme", "common-sense". Use each candidate's own framing only inside quotes.
- **Equal effort.** Research every candidate in the race with the same searches and the same
  depth. If one candidate has a voting record and the other doesn't, say so; don't fill the gap.
- **Evidence or nothing.** Mark a position (`supports`/`opposes`) only when a quote or official
  record shows it directly. Never infer a position from party, endorsements, donors, or
  demographics. No evidence means leave it out: the site shows "No stated position".
- **Verbatim quotes.** `quote` must be copied exactly from the source at `url` (it is checked
  automatically). Keep quotes under ~300 characters. For the voters' guide use
  `https://voter.votewa.gov/genericvoterguide.aspx?e=899&c=17`; for campaign websites use the
  `[page: …]` URL from the bundle.
- **Good sources:** voters' guide, campaign websites, official legislative records
  (app.leg.wa.gov bill pages and roll calls, congress.gov, clerk.house.gov roll calls,
  Seattle/King County council legislation), candidate questionnaires and interviews published by
  news outlets and civic groups (local newspapers, public radio, The Urbanist, Publicola, The
  Stranger, League of Women Voters, Municipal League, Ballotpedia Candidate Connection).
  Prefer pages that load without JavaScript (the checker fetches plain HTML). Don't use opinion
  columns or opponents' attack material as evidence of a candidate's position.
- **Votes and bills** count as evidence: the quote is text on the official page (e.g. the bill's
  title or summary) and `why` says how they voted or that they sponsored it.

## Brief schema (`briefs/<contest id>.json`)

```json
{
  "contest_id": "sos-899-187068",
  "researched": "2026-10-19",
  "candidates": {
    "<candidate id>": {
      "background": "One or two neutral sentences: current role and relevant experience.",
      "record": [
        {"text": "Sponsored SB 5101 (2025), which ... ", "url": "https://app.leg.wa.gov/...", "source": "WA Legislature"}
      ]
    }
  },
  "issues": {
    "<issue id from questions.json>": {
      "summary": "Two or three neutral sentences: where the candidates differ on this issue and where they agree.",
      "differ": true,
      "positions": {
        "<candidate id>": {
          "<option id from questions.json>": {
            "stance": "supports",
            "why": "Short neutral paraphrase of the position.",
            "evidence": [
              {"quote": "exact words from the source", "url": "https://...", "source": "Voters' guide statement"}
            ]
          }
        }
      }
    }
  }
}
```

- Include an issue only if at least one candidate has stated something about it.
- `differ: false` when the candidates' stated positions on the issue are effectively the same
  (the site then tells the voter to decide on other factors).
- `record` is for incumbents and others with a public record; keep it to the 3–6 most relevant items.
