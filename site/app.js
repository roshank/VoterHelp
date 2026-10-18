// VoterHelp: address -> King County districts -> contests on the ballot.
// All content is rendered with textContent (never innerHTML) because it comes from outside sources.

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

function candidateCard(c) {
  const sections = c.statement || [];
  const main = sections.find((s) => s.label === "Statement");
  const others = sections.filter((s) => s !== main);
  return h("article", { class: "candidate" },
    h("div", { class: "cand-head" },
      c.photo ? h("img", { src: `data/${c.photo}`, alt: `Photo of ${c.name}`, loading: "lazy" }) : null,
      h("div", {}, h("div", { class: "name" }, c.name), c.party ? h("div", { class: "party" }, c.party) : null)),
    h("div", { class: "links" },
      c.website ? h("a", { href: c.website, target: "_blank", rel: "noopener nofollow" }, "Campaign website") : null,
      c.email ? h("a", { href: `mailto:${c.email}` }, c.email) : null),
    main ? [h("div", { class: "section-label" }, "In their words"), ...paragraphs(main.paragraphs)] : h("p", {}, "No statement submitted."),
    others.length ? h("details", {},
      h("summary", {}, "Experience, education and endorsements"),
      others.map((s) => [h("div", { class: "section-label" }, s.label), ...paragraphs(s.paragraphs)])) : null);
}

function sourceLine(contest) {
  return h("div", { class: "source" }, "Source: ",
    h("a", { href: contest.source.url, target: "_blank", rel: "noopener" }, contest.source.name),
    ` (retrieved ${contest.source.fetched_at.slice(0, 10)})`);
}

function measureCard(m) {
  return h("section", { class: "contest measure" },
    h("h3", {}, m.title),
    h("div", { class: "meta" }, m.jurisdiction,
      m.match?.approx ? " · We matched this district approximately; check your printed ballot." : ""),
    m.short_description ? h("p", { class: "desc" }, m.short_description) : null,
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

function raceCard(c) {
  const meta = [c.jurisdiction, c.term].filter(Boolean).join(" · ");
  return h("section", { class: "contest" },
    h("h3", {}, c.title),
    h("div", { class: "meta" }, meta, c.candidates.length === 1 ? " · Unopposed" : ""),
    h("div", { class: "candidates" }, c.candidates.map(candidateCard)),
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

function render(districts, matchedAddress) {
  const main = $("#ballot");
  const shown = data.contests.filter((c) => onBallot(c, districts));
  const byGroup = {};
  for (const c of shown) (byGroup[groupOf(c)] ||= []).push(c);
  main.replaceChildren(...[
    matchedAddress ? h("p", { class: "districts" }, h("strong", {}, `Ballot for ${matchedAddress}. `), districtSummary(districts)) : null,
    ...GROUPS.filter((g) => byGroup[g.key]?.length).map((g) => [
      h("h2", { class: "group-title" }, g.title),
      g.note ? h("p", { class: "districts" }, g.note) : null,
      byGroup[g.key].map((c) => (c.type === "measure" ? measureCard(c) : raceCard(c))),
    ]),
  ].flat(Infinity).filter(Boolean));
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
    render(districts, hit.address);
    $("#ballot").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    setStatus(`King County's map service didn't respond (${err.message}). Try again, or browse every race below.`, "error");
    render(null);
  }
}

async function init() {
  data = await (await fetch("data/ballot.json")).json();
  $("#generated").textContent = `Data last updated ${new Date(data.generated_at).toLocaleString()}.`;
  $("#lookup").addEventListener("submit", (e) => {
    e.preventDefault();
    const address = $("#address").value.trim();
    if (address) lookup(address);
  });
  $("#show-all").addEventListener("click", () => {
    setStatus("Showing every race in King County. Enter your address to see only yours.");
    render(null);
  });
}

init();
