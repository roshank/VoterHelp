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
let ballot = null; // { districts, address } once the voter has asked for a ballot
const chosen = { chips: new Set(), custom: [] };

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

// Sentences in a candidate's own statement that mention a priority. Experience, education and
// endorsement lists are skipped: "School of Law" or "Labor Council" isn't a position on schools or labor.
function mentions(candidate, priority) {
  const hits = [];
  for (const section of candidate.statement || []) {
    if (section.label !== "Statement") continue;
    for (const para of section.paragraphs) {
      for (const sentence of sentences(para)) {
        const ranges = findMatches(priority.matcher, sentence);
        if (ranges.length) hits.push({ sentence, ranges });
      }
    }
  }
  return hits;
}

function prioritySummary(candidate, prios) {
  const rows = prios.map((p) => ({ p, hits: mentions(candidate, p) }));
  const count = rows.filter((r) => r.hits.length).length;
  return h("div", { class: "prios" },
    h("div", { class: `badge ${count ? "" : "none"}` },
      prios.length === 1 ? (count ? "Mentions your priority" : "Doesn't mention your priority")
        : count ? `Mentions ${count} of your ${prios.length} priorities` : "Doesn't mention your priorities"),
    rows.map(({ p, hits }) => h("div", { class: "prio-row" },
      h("div", { class: "prio-label" }, p.label),
      hits.length
        ? hits.slice(0, 2).map((hit) => h("blockquote", {}, highlighted(hit.sentence, hit.ranges)))
        : h("p", { class: "muted" }, "Not mentioned in their statement."),
      hits.length > 2 ? h("p", { class: "muted small" }, `+${hits.length - 2} more in their full statement`) : null)));
}

function renderChips() {
  const chips = ISSUES.map((i) => h("button", {
    type: "button", class: "chip", "aria-pressed": String(chosen.chips.has(i.id)), "data-chip": i.id,
  }, i.label));
  const custom = chosen.custom.map((t) => h("button", {
    type: "button", class: "chip custom", "aria-pressed": "true", "data-custom": t, title: `Remove “${t}”`,
  }, `“${t}” ×`));
  $("#chips").replaceChildren(...chips, ...custom);

  const prios = priorities();
  const bar = $("#priority-bar");
  bar.hidden = !ballot;
  bar.replaceChildren(h("div", { class: "wrap bar-inner" },
    h("span", { class: "bar-label" }, prios.length ? "Your priorities:" : "No priorities picked."),
    prios.map((p) => h("span", { class: "pill" }, p.label)),
    h("button", { type: "button", class: "linkish", "data-edit": "1" }, prios.length ? "Change" : "Pick some")));
}

function savePriorities() {
  const params = new URLSearchParams();
  if (chosen.chips.size) params.set("topics", [...chosen.chips].join(","));
  if (chosen.custom.length) params.set("q", chosen.custom.join("|"));
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

function loadPriorities() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const id of (params.get("topics") || "").split(",")) if (ISSUES.some((i) => i.id === id)) chosen.chips.add(id);
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

function raceCard(c, prios) {
  const meta = [c.jurisdiction, c.term].filter(Boolean).join(" · ");
  return h("section", { class: "contest" },
    h("h3", {}, c.title),
    h("div", { class: "meta" }, meta, c.candidates.length === 1 ? " · Unopposed" : ""),
    h("div", { class: "candidates" }, c.candidates.map((cand) => candidateCard(cand, prios))),
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
    prios.length ? h("p", { class: "districts" }, "Highlighted sentences are word for word from each candidate's voters' guide statement. They show what candidates chose to talk about, not where they stand.") : null,
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
  renderChips();
  data = await (await fetch("data/ballot.json")).json();
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
