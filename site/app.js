// VoterHelp: address -> King County districts -> contests on the ballot.
// All content is rendered with textContent (never innerHTML) because it comes from outside sources.

import { ISSUES, priorityFromChip, priorityFromText, findMatches, sentences } from "./issues.js";

const GIS = "https://gismaps.kingcounty.gov/arcgis/rest/services";
const GEOCODER = `${GIS}/Address/Composite_locator/GeocodeServer/findAddressCandidates`;

// Keys match the "layer" values written by pipeline/districts.py.
const LAYERS = {
  cong: { url: `${GIS}/Districts/DistrictsReport/MapServer/11`, field: "CONGDST", label: (v) => `Congressional District ${v}` },
  leg: { url: `${GIS}/Districts/DistrictsReport/MapServer/12`, field: "LEGDST", label: (v) => `Legislative District ${v}` },
  kcc: { url: `${GIS}/Districts/DistrictsReport/MapServer/9`, field: "KCCDST", label: (v) => `County Council District ${v}` },
  jud: { url: `${GIS}/Districts/DistrictsReport/MapServer/8`, field: "juddst", label: null },
  city: { url: `${GIS}/Districts/DistrictsReport/MapServer/2`, field: "CITYNAME", label: (v) => (v === "King County" ? "Unincorporated King County" : `City of ${v}`) },
  sch: { url: `${GIS}/Districts/DistrictsReport/MapServer/14`, field: "SCHDST", label: null },
  fire: { url: `${GIS}/Districts/DistrictsReport/MapServer/15`, field: "FIRDST", label: null },
  scc: { url: `${GIS}/Districts/KingCo_Electoral_Districts/MapServer/4`, field: "SCCDST", label: (v) => `Seattle Council District ${v.replace("SCC", "")}` },
};

const GROUPS = [
  { key: "local", title: "City and local" },
  { key: "county", title: "King County" },
  { key: "leg", title: "State Legislature" },
  { key: "courts", title: "Washington courts" },
  { key: "fed", title: "U.S. Congress" },
  { key: "state", title: "Statewide ballot measures" },
  { key: "maybe", title: "May be on your ballot", note: "We couldn't match these to an address yet. Check your printed ballot." },
];

const $ = (sel) => document.querySelector(sel);
let data;
let websites = {}; // candidate id -> scraped campaign website text (site/data/websites.json)
let finance = {}; // candidate id -> PDC campaign finance summary (site/data/finance.json)
let advisor = { questions: {}, races: {} }; // researched race briefs (site/data/advisor.json)
let ballot = null; // { districts, address } once the voter has asked for a ballot
const chosen = { chips: new Set(), custom: [], answers: new Set() }; // answers: advisor option ids

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function setStatus(msg, kind = "") {
  const box = $("#status");
  box.replaceChildren(msg ? h("div", { class: `status-box ${kind}` }, msg) : "");
}

async function getJSON(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const resp = await fetch(u);
  if (!resp.ok) throw new Error(`${resp.status} from ${u.host}`);
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "map service error");
  return json;
}

async function geocode(address) {
  // King County's locator names unincorporated places "King County", so "…, Vashon" can fail.
  // If the full address doesn't match, retry with just the street (plus ZIP when given).
  const zip = address.match(/\b98\d{3}\b/)?.[0];
  const street = address.split(",")[0].trim();
  const attempts = [address];
  if (street !== address) attempts.push(zip ? `${street} ${zip}` : street);
  for (const attempt of attempts) {
    const json = await getJSON(GEOCODER, { SingleLine: attempt, outSR: 4326, maxLocations: 5, f: "json" });
    const good = (json.candidates || []).filter((c) => c.score >= 80).sort((a, b) => b.score - a.score);
    if (good.length) return good[0];
  }
  return null;
}

async function districtsAt({ x, y }) {
  const entries = await Promise.all(Object.entries(LAYERS).map(async ([key, layer]) => {
    const json = await getJSON(`${layer.url}/query`, {
      geometry: `${x},${y}`, geometryType: "esriGeometryPoint", inSR: 4326,
      spatialRel: "esriSpatialRelIntersects", outFields: layer.field, returnGeometry: false, f: "json",
    });
    const values = [...new Set((json.features || []).map((f) => String(f.attributes[layer.field])))];
    return [key, values];
  }));
  return Object.fromEntries(entries);
}

const isJudicial = (c) => c.category === "JUD" || /Judge/.test(c.title);

function groupOf(contest) {
  const layer = contest.match?.layer;
  if (!contest.match) return "maybe";
  switch (contest.category) {
    case "MEA": return layer === "all" ? "state" : "local";
    case "FED": return "fed";
    case "LEG": return "leg";
    case "JUD": return "courts";
    default: return layer === "city" || layer === "scc" ? "local" : "county";
  }
}

function onBallot(contest, districts) {
  if (!districts) return true;
  const m = contest.match;
  if (!m) return true; // shown under "May be on your ballot"
  if (m.layer === "all") return true;
  return (districts[m.layer] || []).includes(m.value);
}

function paragraphs(list) {
  return (list || []).map((p) => h("p", {}, p));
}

// ---- Priorities ----------------------------------------------------------

function priorities() {
  return [
    ...ISSUES.filter((i) => chosen.chips.has(i.id)).map((i) => priorityFromChip(i.id)),
    ...chosen.custom.map(priorityFromText).filter(Boolean),
  ];
}

function highlighted(text, ranges) {
  const out = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start < pos) continue; // overlapping match
    if (start > pos) out.push(text.slice(pos, start));
    out.push(h("mark", {}, text.slice(start, end)));
    pos = end;
  }
  out.push(text.slice(pos));
  return out;
}

function sentenceHits(paragraphs, priority, extra = {}) {
  const hits = [];
  for (const para of paragraphs) {
    for (const sentence of sentences(para)) {
      const ranges = findMatches(priority.matcher, sentence);
      if (ranges.length) hits.push({ sentence, ranges, ...extra });
    }
  }
  return hits;
}

// Sentences where a candidate mentions a priority: first their voters' guide statement, then their
// campaign website. Experience, education and endorsement lists are skipped: "School of Law" or
// "Labor Council" isn't a position on schools or labor.
function mentions(candidate, priority) {
  const statement = (candidate.statement || []).filter((s) => s.label === "Statement").flatMap((s) => s.paragraphs);
  const guide = sentenceHits(statement, priority);
  const seen = new Set(guide.map((hit) => hit.sentence));
  const site = (websites[candidate.id]?.pages || [])
    .flatMap((page) => sentenceHits(page.paragraphs, priority, { page }))
    .filter((hit) => !seen.has(hit.sentence) && seen.add(hit.sentence));
  return { guide, site };
}

function quoteGroup(label, hits, link) {
  if (!hits.length) return null;
  // Sentences that hit the topic several times say more about it, so they go first.
  const ranked = [...hits].sort((a, b) => b.ranges.length - a.ranges.length);
  const quote = (hit) => h("blockquote", {},
    highlighted(hit.sentence, hit.ranges),
    link && hit.page ? [" ", h("a", { href: hit.page.url, target: "_blank", rel: "noopener nofollow", class: "small" }, "source")] : null);
  return h("div", { class: "quote-group" },
    h("div", { class: "quote-source" }, label),
    ranked.slice(0, 2).map(quote),
    ranked.length > 2 ? h("details", { class: "more" }, h("summary", {}, `${ranked.length - 2} more`), ranked.slice(2).map(quote)) : null);
}

function prioritySummary(candidate, prios) {
  const site = websites[candidate.id];
  const siteRead = Boolean(site?.pages?.length);
  const rows = prios.map((p) => ({ p, ...mentions(candidate, p) }));
  const count = rows.filter((r) => r.guide.length || r.site.length).length;
  const where = siteRead ? "their statement or campaign website" : "their statement";
  return h("div", { class: "prios" },
    h("div", { class: `badge ${count ? "" : "none"}` },
      prios.length === 1 ? (count ? "Mentions your priority" : "Doesn't mention your priority")
        : count ? `Mentions ${count} of your ${prios.length} priorities` : "Doesn't mention your priorities"),
    rows.map(({ p, guide, site: siteHits }) => h("div", { class: "prio-row" },
      h("div", { class: "prio-label" }, p.label),
      quoteGroup("Voters' guide statement", guide, false),
      quoteGroup("Campaign website", siteHits, true),
      guide.length || siteHits.length ? null : h("p", { class: "muted" }, `Not mentioned in ${where}.`))),
    candidate.website && !siteRead
      ? h("p", { class: "muted small" }, "We couldn't read their campaign website, so only their statement was searched.")
      : null);
}

function renderChips() {
  const chips = ISSUES.map((i) => h("button", {
    type: "button", class: "chip", "aria-pressed": String(chosen.chips.has(i.id)), "data-chip": i.id,
  }, i.label));
  const custom = chosen.custom.map((t) => h("button", {
    type: "button", class: "chip custom", "aria-pressed": "true", "data-custom": t, title: `Remove “${t}”`,
  }, `“${t}” ×`));
  $("#chips").replaceChildren(...chips, ...custom);
  renderFollowups();

  const prios = priorities();
  const bar = $("#priority-bar");
  bar.hidden = !ballot;
  bar.replaceChildren(h("div", { class: "wrap bar-inner" },
    h("span", { class: "bar-label" }, prios.length ? "Your priorities:" : "No priorities picked."),
    prios.map((p) => h("span", { class: "pill" }, p.label)),
    h("button", { type: "button", class: "linkish", "data-edit": "1" }, prios.length ? "Change" : "Pick some")));
}

// Follow-up questions for each picked topic, so the advisor knows what the voter means by it.
function renderFollowups() {
  const blocks = [...chosen.chips].flatMap((issueId) => (advisor.questions[issueId] || []).map((q) =>
    h("fieldset", { class: "followup" },
      h("legend", {}, q.text, h("span", { class: "muted small" }, " Pick any that apply")),
      h("div", { class: "options" }, q.options.map((o) => h("label", { class: "option" },
        h("input", { type: "checkbox", "data-answer": o.id, checked: chosen.answers.has(o.id) }),
        h("span", {}, h("strong", {}, o.label), h("span", { class: "muted small" }, ` ${o.detail}`))))))));
  $("#followups").replaceChildren(...(blocks.length
    ? [h("p", { class: "followup-intro" }, "Tell us a bit more, so we can compare candidates on what you mean (optional):"), ...blocks]
    : []));
}

function savePriorities() {
  const params = new URLSearchParams();
  if (chosen.chips.size) params.set("topics", [...chosen.chips].join(","));
  if (chosen.answers.size) params.set("a", [...chosen.answers].join(","));
  if (chosen.custom.length) params.set("q", chosen.custom.join("|"));
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

function loadPriorities() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const id of (params.get("topics") || "").split(",")) if (ISSUES.some((i) => i.id === id)) chosen.chips.add(id);
  for (const id of (params.get("a") || "").split(",")) if (/^[a-z_]+$/.test(id)) chosen.answers.add(id);
  chosen.custom = (params.get("q") || "").split("|").map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 8);
}

function prioritiesChanged() {
  savePriorities();
  renderChips();
  if (ballot) render();
}

function addCustom() {
  const input = $("#custom-input");
  for (const t of input.value.split(",").map((x) => x.trim()).filter((x) => x.length >= 2)) {
    if (!chosen.custom.some((c) => c.toLowerCase() === t.toLowerCase())) chosen.custom.push(t);
  }
  input.value = "";
  prioritiesChanged();
}

// ---- Campaign money --------------------------------------------------------

// Fixed order, so a source always has the same color across every candidate.
const MONEY_SOURCES = [
  "Individuals", "Small or unitemized contributions", "PACs and political committees", "Businesses",
  "Unions", "Political parties", "Other organizations", "The candidate",
];
const pct = (part, total) => (part / total < 0.005 ? "<1%" : `${Math.round((100 * part) / total)}%`);
const usd = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function moneyBar(byType, total) {
  const parts = MONEY_SOURCES.map((name, i) => ({ name, i, amount: byType[name] || 0 })).filter((p) => p.amount > 0);
  return [
    h("div", { class: "money-bar", role: "img", "aria-label": "Where the money came from" },
      parts.map((p) => h("span", {
        class: `seg s${p.i + 1}`, style: `flex-grow: ${p.amount}`,
        title: `${p.name}: ${usd(p.amount)} (${pct(p.amount, total)})`,
      }))),
    h("ul", { class: "money-legend" }, parts.map((p) => h("li", {},
      h("span", { class: `swatch s${p.i + 1}`, "aria-hidden": "true" }),
      h("span", { class: "src" }, p.name),
      h("span", { class: "amt" }, `${usd(p.amount)} · ${pct(p.amount, total)}`)))),
  ];
}

function spenders(list) {
  return h("ul", { class: "money-list" }, list.slice(0, 5).map((x) => h("li", {}, h("span", {}, x.name), h("span", { class: "amt" }, usd(x.total)))));
}

function moneySection(c) {
  const f = finance[c.id];
  if (!f) return null;
  if (f.federal) {
    return h("details", { class: "money" }, h("summary", {}, "Campaign money"),
      h("p", { class: "small" }, "Candidates for Congress report to the Federal Election Commission. ",
        h("a", { href: f.fec_url, target: "_blank", rel: "noopener" }, "See their FEC filings")));
  }
  if (f.no_committee) {
    return h("details", { class: "money" }, h("summary", {}, "Campaign money"),
      h("p", { class: "small" }, "No campaign committee is registered with the Public Disclosure Commission, which usually means little or no money raised."));
  }
  const totalBySource = Object.values(f.by_type).reduce((a, b) => a + b, 0);
  return h("details", { class: "money" },
    h("summary", {}, `Campaign money: raised ${usd(f.raised)}`),
    h("p", { class: "small money-totals" },
      `Raised ${usd(f.raised)}`, f.carried_forward ? ` (plus ${usd(f.carried_forward)} carried over)` : "",
      ` · Spent ${usd(f.spent)}`, f.individual_donors ? ` · ${f.individual_donors.toLocaleString()} individual donors` : ""),
    totalBySource > 0 ? [h("div", { class: "section-label" }, "Where it came from"), moneyBar(f.by_type, totalBySource)] : null,
    f.top_organizations.length ? [h("div", { class: "section-label" }, "Largest organizational donors"), spenders(f.top_organizations)] : null,
    f.outside_support.length ? [h("div", { class: "section-label" }, "Outside groups spending to support"), spenders(f.outside_support)] : null,
    f.outside_opposition.length ? [h("div", { class: "section-label" }, "Outside groups spending to oppose"), spenders(f.outside_opposition)] : null,
    h("p", { class: "source" }, "Source: ",
      h("a", { href: f.pdc_url || "https://www.pdc.wa.gov/", target: "_blank", rel: "noopener" }, "WA Public Disclosure Commission"),
      ` (${f.pdc_name}). Outside spending is by groups not controlled by the campaign.`));
}

// ---- Ballot cards --------------------------------------------------------

function candidateCard(c, prios) {
  const sections = c.statement || [];
  const main = sections.find((s) => s.label === "Statement");
  const others = sections.filter((s) => s !== main);
  const fullStatement = [
    main ? paragraphs(main.paragraphs) : h("p", {}, "No statement submitted."),
    others.map((s) => [h("div", { class: "section-label" }, s.label), ...paragraphs(s.paragraphs)]),
  ];
  return h("article", { class: "candidate" },
    h("div", { class: "cand-head" },
      c.photo ? h("img", { src: `data/${c.photo}`, alt: `Photo of ${c.name}`, loading: "lazy" }) : null,
      h("div", {}, h("div", { class: "name" }, c.name), c.party ? h("div", { class: "party" }, c.party) : null)),
    h("div", { class: "links" },
      c.website ? h("a", { href: c.website, target: "_blank", rel: "noopener nofollow" }, "Campaign website") : null,
      c.email ? h("a", { href: `mailto:${c.email}` }, c.email) : null),
    prios.length ? prioritySummary(c, prios) : null,
    moneySection(c),
    h("details", { open: !prios.length }, h("summary", {}, "Full statement in their words"), fullStatement));
}

function sourceLine(contest) {
  return h("div", { class: "source" }, "Source: ",
    h("a", { href: contest.source.url, target: "_blank", rel: "noopener" }, contest.source.name),
    ` (retrieved ${contest.source.fetched_at.slice(0, 10)})`);
}

function measureTopics(m, prios) {
  const text = [m.short_description, ...m.ballot_title, ...m.explanatory_statement].join(" ");
  const hits = prios.filter((p) => findMatches(p.matcher, text).length >= 2); // one passing mention isn't "related"
  return hits.length ? h("p", { class: "touches" }, "Related to your priorities: ", hits.map((p) => h("span", { class: "pill" }, p.label))) : null;
}

function measureCard(m, prios) {
  return h("section", { class: "contest measure" },
    h("h3", {}, m.title),
    h("div", { class: "meta" }, m.jurisdiction,
      m.match?.approx ? " · We matched this district approximately; check your printed ballot." : ""),
    m.short_description ? h("p", { class: "desc" }, m.short_description) : null,
    prios.length ? measureTopics(m, prios) : null,
    m.ballot_title.length ? h("details", { open: true }, h("summary", {}, "Ballot title"), paragraphs(m.ballot_title)) : null,
    m.explanatory_statement.length ? h("details", {}, h("summary", {}, "Explanatory statement (what it would do)"), paragraphs(m.explanatory_statement)) : null,
    m.fiscal_statement.length ? h("details", {}, h("summary", {}, "Fiscal impact"), paragraphs(m.fiscal_statement)) : null,
    (m.argument_for.length || m.argument_against.length) ? h("div", { class: "sides" },
      h("div", { class: "side for" },
        h("h4", {}, "Argument for"), m.argument_for.length ? paragraphs(m.argument_for) : h("p", {}, "No argument submitted."),
        m.rebuttal_by_proponents.length ? h("details", {}, h("summary", {}, "Their rebuttal to the argument against"), paragraphs(m.rebuttal_by_proponents)) : null,
        m.committee_for ? h("p", { class: "committee" }, `Written by: ${m.committee_for}`) : null),
      h("div", { class: "side against" },
        h("h4", {}, "Argument against"), m.argument_against.length ? paragraphs(m.argument_against) : h("p", {}, "No argument submitted."),
        m.rebuttal_by_opponents.length ? h("details", {}, h("summary", {}, "Their rebuttal to the argument for"), paragraphs(m.rebuttal_by_opponents)) : null,
        m.committee_against ? h("p", { class: "committee" }, `Written by: ${m.committee_against}`) : null)) : null,
    m.full_text_url ? h("p", {}, h("a", { href: m.full_text_url, target: "_blank", rel: "noopener" }, "Full text")) : null,
    sourceLine(m));
}

// ---- Advisor ---------------------------------------------------------------

const optionInfo = (issueId, optId) => {
  for (const q of advisor.questions[issueId] || []) {
    const o = q.options.find((x) => x.id === optId);
    if (o) return o;
  }
  return { id: optId, label: optId };
};

function evidenceList(evidence) {
  return h("ul", { class: "evidence" }, evidence.map((ev) => h("li", {},
    h("q", {}, ev.quote), " ",
    h("a", { href: ev.url, target: "_blank", rel: "noopener nofollow", class: "small" }, ev.source || "source"))));
}

function stanceCell(pos) {
  if (!pos) return h("div", { class: "stance none" }, h("span", { class: "mark" }, "–"), " No stated position");
  const yes = pos.stance === "supports";
  return h("div", { class: `stance ${yes ? "yes" : "no"}` },
    h("span", { class: "mark", "aria-hidden": "true" }, yes ? "✓" : "✗"), ` ${yes ? "Supports" : "Opposes"}. `, pos.why || "",
    h("details", { class: "ev" }, h("summary", {}, "Evidence"), evidenceList(pos.evidence)));
}

// Tally, per candidate, how their documented positions line up with the options the voter picked.
function fitFor(contest, brief) {
  const tally = Object.fromEntries(contest.candidates.map((c) => [c.id, { agree: 0, differ: 0, unknown: 0 }]));
  let asked = 0;
  for (const issueId of chosen.chips) {
    const issue = brief.issues[issueId];
    for (const q of advisor.questions[issueId] || []) {
      for (const o of q.options) {
        if (!chosen.answers.has(o.id)) continue;
        asked++;
        for (const c of contest.candidates) {
          const pos = issue?.positions?.[c.id]?.[o.id];
          tally[c.id][!pos ? "unknown" : pos.stance === "supports" ? "agree" : "differ"]++;
        }
      }
    }
  }
  return { tally, asked };
}

function bottomLine(contest, brief) {
  const { tally, asked } = fitFor(contest, brief);
  if (!asked) {
    return h("p", { class: "bottom muted" }, "Answer the follow-up questions under your topics to see which candidate's stated positions are closest to yours.");
  }
  const score = (c) => tally[c.id].agree - tally[c.id].differ;
  const ranked = [...contest.candidates].sort((a, b) => score(b) - score(a));
  const [top, next] = ranked;
  const line = (c) => {
    const t = tally[c.id];
    return `${c.name}: agrees on ${t.agree} of your ${asked} picks${t.differ ? `, differs on ${t.differ}` : ""}${t.unknown ? `, no stated position on ${t.unknown}` : ""}.`;
  };
  const clear = score(top) > 0 && score(top) > score(next);
  return h("div", { class: `bottom ${clear ? "clear" : ""}` },
    h("strong", {}, clear ? `Closest to your answers: ${top.name}` : "No clear difference on what you told us"),
    h("p", { class: "small" }, clear ? "" : "On your picks, their stated positions are about the same, or there isn't enough on record. Decide on other factors like experience, background and who's funding them."),
    h("ul", { class: "small tally" }, ranked.map((c) => h("li", {}, line(c)))));
}

function advisorPanel(contest) {
  const brief = advisor.races[contest.id];
  if (!brief) return null;
  const issues = [...chosen.chips].filter((id) => brief.issues[id]);
  const cands = contest.candidates;
  return h("div", { class: "advisor" },
    h("div", { class: "advisor-head" },
      h("strong", {}, "Advisor: how they compare on what you care about"),
      h("span", { class: "muted small" }, " Researched by AI from public sources. Every claim links to its evidence.")),
    chosen.chips.size ? bottomLine(contest, brief) : h("p", { class: "muted small" }, "Pick topics above to compare these candidates."),
    issues.map((issueId) => {
      const issue = brief.issues[issueId];
      const label = ISSUES.find((i) => i.id === issueId)?.label || issueId;
      const picked = (advisor.questions[issueId] || []).flatMap((q) => q.options).filter((o) => chosen.answers.has(o.id)).map((o) => o.id);
      // Show the options the voter picked; if none, show every option a candidate took a position on.
      const opts = picked.length ? picked
        : [...new Set(cands.flatMap((c) => Object.keys(issue.positions[c.id] || {})))];
      return h("section", { class: "adv-issue" },
        h("h4", {}, label, issue.differ === false ? h("span", { class: "same-tag" }, "Similar positions") : null),
        h("p", { class: "small" }, issue.summary),
        opts.map((optId) => {
          const o = optionInfo(issueId, optId);
          return h("div", { class: "adv-option" },
            h("div", { class: "opt-label" }, picked.length ? "You picked: " : "", o.label),
            h("div", { class: "adv-grid" }, cands.map((c) => h("div", { class: "adv-cell" },
              h("div", { class: "cell-name" }, c.name),
              stanceCell(issue.positions[c.id]?.[optId])))));
        }));
    }),
    issues.length < chosen.chips.size
      ? h("p", { class: "muted small" }, "Topics not shown: neither candidate has said anything we could document about them.")
      : null,
    h("details", { class: "adv-bg" }, h("summary", {}, "Background and record"),
      h("div", { class: "adv-grid" }, cands.map((c) => {
        const b = brief.candidates?.[c.id] || {};
        return h("div", { class: "adv-cell" },
          h("div", { class: "cell-name" }, c.name),
          b.background ? h("p", { class: "small" }, b.background) : null,
          b.record?.length ? h("ul", { class: "evidence" }, b.record.map((r) => h("li", {}, r.text, " ",
            h("a", { href: r.url, target: "_blank", rel: "noopener nofollow", class: "small" }, r.source || "source")))) : null);
      }))));
}

function raceCard(c, prios) {
  const meta = [c.jurisdiction, c.term].filter(Boolean).join(" · ");
  return h("section", { class: "contest" },
    h("h3", {}, c.title),
    h("div", { class: "meta" }, meta, c.candidates.length === 1 ? " · Unopposed" : ""),
    isJudicial(c) ? h("p", { class: "muted small" }, "Judicial candidates are barred by the Code of Judicial Conduct from promising how they'd rule on issues. Compare experience, background and ratings instead.") : null,
    advisorPanel(c),
    // With an advisor brief, keyword matching is only needed for typed-in priorities.
    h("div", { class: "candidates" }, c.candidates.map((cand) => candidateCard(cand, advisor.races[c.id] ? prios.filter((p) => p.text) : prios))),
    sourceLine(c));
}

function districtSummary(districts) {
  const parts = [];
  for (const [key, layer] of Object.entries(LAYERS)) {
    if (!layer.label) continue;
    for (const v of districts[key] || []) parts.push(layer.label(v));
  }
  return parts.join(" · ");
}

function render() {
  const { districts, address } = ballot;
  const prios = priorities();
  const shown = data.contests.filter((c) => onBallot(c, districts));
  const byGroup = {};
  for (const c of shown) (byGroup[groupOf(c)] ||= []).push(c);
  renderChips();
  $("#ballot").replaceChildren(...[
    address ? h("p", { class: "districts" }, h("strong", {}, `Ballot for ${address}. `), districtSummary(districts)) : null,
    prios.length ? h("p", { class: "districts" }, "Highlighted sentences are word for word from each candidate's voters' guide statement or campaign website. They show what candidates chose to talk about, not where they stand.") : null,
    ...GROUPS.filter((g) => byGroup[g.key]?.length).map((g) => [
      h("h2", { class: "group-title" }, g.title),
      g.note ? h("p", { class: "districts" }, g.note) : null,
      byGroup[g.key].map((c) => (c.type === "measure" ? measureCard(c, prios) : raceCard(c, prios))),
    ]),
  ].flat(Infinity).filter(Boolean));
}

function showBallot(districts, address) {
  ballot = { districts, address };
  render();
  $("#priority-bar").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function lookup(address) {
  setStatus("Finding your address…");
  try {
    const hit = await geocode(address);
    if (!hit) {
      setStatus("We couldn't find that address in King County. Try adding the city, e.g. \"1301 5th Ave, Seattle\".", "error");
      return;
    }
    setStatus("Looking up your districts…");
    const districts = await districtsAt(hit.location);
    if (!districts.cong.length) {
      setStatus("That address looks like it's outside King County. This guide covers King County only for now.", "error");
      return;
    }
    setStatus("");
    showBallot(districts, hit.address);
  } catch (err) {
    console.error(err);
    setStatus(`King County's map service didn't respond (${err.message}). Try again, or browse every race below.`, "error");
    showBallot(null, null);
  }
}

async function init() {
  loadPriorities();
  advisor = (await fetch("data/advisor.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)) || advisor;
  renderChips();
  data = await (await fetch("data/ballot.json")).json();
  // Website text and finance data are optional extras: the guide works without them.
  const extra = (file) => fetch(file).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  extra("data/websites.json").then((w) => { websites = w?.candidates || {}; if (ballot) render(); });
  extra("data/finance.json").then((f) => { finance = f?.candidates || {}; if (ballot) render(); });
  $("#generated").textContent = `Data last updated ${new Date(data.generated_at).toLocaleString()}.`;

  $("#chips").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.chip) {
      const id = btn.dataset.chip;
      chosen.chips.has(id) ? chosen.chips.delete(id) : chosen.chips.add(id);
    } else if (btn.dataset.custom) {
      chosen.custom = chosen.custom.filter((t) => t !== btn.dataset.custom);
    }
    prioritiesChanged();
  });
  $("#followups").addEventListener("change", (e) => {
    const id = e.target.dataset?.answer;
    if (!id) return;
    e.target.checked ? chosen.answers.add(id) : chosen.answers.delete(id);
    savePriorities();
    if (ballot) render();
  });
  $("#add-custom").addEventListener("click", addCustom);
  $("#custom-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustom(); }
  });
  $("#priority-bar").addEventListener("click", (e) => {
    if (e.target.closest("[data-edit]")) $(".top").scrollIntoView({ behavior: "smooth" });
  });
  $("#lookup").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("#custom-input").value.trim()) addCustom();
    const address = $("#address").value.trim();
    if (address) lookup(address);
  });
  $("#show-all").addEventListener("click", () => {
    setStatus("Showing every race in King County. Enter your address to see only yours.");
    showBallot(null, null);
  });
}

init();
