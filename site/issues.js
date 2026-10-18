// Topic chips and the words that count as a mention. Each term matches whole words plus
// common endings ("tax" -> "taxes"); a trailing * matches any word starting with it.
// All-caps terms (acronyms like ICE) match case-sensitively.
// Keep these neutral: they find where a candidate talks about a topic, not which side they take.
export const ISSUES = [
  { id: "housing", label: "Housing & homelessness",
    terms: ["housing", "homeless*", "unhoused", "rent", "rental", "renter", "tenant", "eviction", "landlord", "shelter", "encampment", "home ownership", "homeowner", "mortgage", "zoning", "density"] },
  { id: "safety", label: "Public safety & policing",
    terms: ["public safety", "safety", "police", "policing", "officer", "crime", "criminal", "violence", "violent", "gun", "firearm", "jail", "incarcerat*", "prosecut*", "sheriff", "911", "fentanyl", "theft"] },
  { id: "cost", label: "Taxes & cost of living",
    terms: ["tax", "taxpayer", "afford*", "unafford*", "cost of living", "cost", "budget", "spending", "levy", "levies", "fee", "inflation", "price", "wealth", "regressive"] },
  { id: "transport", label: "Transit & roads",
    terms: ["transit", "transportation", "bus", "buses", "light rail", "sound transit", "metro", "traffic", "road", "bike", "biking", "bicycl*", "pedestrian", "sidewalk", "ferry", "ferries", "commute", "congestion", "rapidride"] },
  { id: "climate", label: "Climate & environment",
    terms: ["climate", "environment*", "clean energy", "emission", "carbon", "pollution", "salmon", "orca", "conservation", "wildfire", "sustainab*", "green", "clean air", "clean water", "tree"] },
  { id: "schools", label: "Schools & kids",
    terms: ["school", "education", "teacher", "student", "classroom", "child care", "childcare", "early learning", "kids", "children", "youth", "college", "tuition", "parent"] },
  { id: "health", label: "Health & mental health",
    terms: ["health care", "healthcare", "mental health", "behavioral health", "public health", "addiction", "treatment", "recovery", "hospital", "medicaid", "medicare", "abortion", "reproductive", "overdose"] },
  { id: "economy", label: "Jobs & economy",
    terms: ["job", "economy", "economic", "business", "small business", "worker", "labor", "union", "wage", "minimum wage", "employment", "employer"] },
  { id: "rights", label: "Civil rights & immigration",
    terms: ["civil rights", "equity", "equitable", "immigrant", "immigration", "ICE", "refugee", "discrimination", "LGBTQ", "racial", "racism", "voting rights", "democracy", "disabilit*"] },
  { id: "government", label: "Accountable government",
    terms: ["accountab*", "transparen*", "audit", "ethics", "corruption", "waste", "efficien*", "oversight", "bureaucra*"] },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENDINGS = "(?:s|es|ed|ing|er|ers|al|ly)?";

function termPattern(term) {
  return term.trim().split(/\s+/).map((w) => {
    if (w.endsWith("*")) return `${escapeRe(w.slice(0, -1))}\\w*`;
    const base = w.length > 3 ? w.replace(/s$/i, "") : w; // "lanes" -> "lane" (+ endings)
    return escapeRe(base) + ENDINGS;
  }).join("[\\s-]+");
}

const isAcronym = (t) => /^[A-Z0-9]{2,}$/.test(t) && /[A-Z]/.test(t);

export function matcherFor(terms) {
  const acronyms = terms.filter(isAcronym);
  const rest = terms.filter((t) => !isAcronym(t));
  return [
    rest.length && new RegExp(`\\b(?:${rest.map(termPattern).join("|")})\\b`, "gi"),
    acronyms.length && new RegExp(`\\b(?:${acronyms.map(termPattern).join("|")})\\b`, "g"),
  ].filter(Boolean);
}

// [start, end] ranges of every match in text, in order.
export function findMatches(matcher, text) {
  const ranges = [];
  for (const re of matcher) {
    for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

// A priority is either a chip or free text typed by the voter.
export function priorityFromChip(id) {
  const issue = ISSUES.find((i) => i.id === id);
  return issue && { key: issue.id, label: issue.label, matcher: matcherFor(issue.terms) };
}

export function priorityFromText(text) {
  const clean = text.trim().replace(/\s+/g, " ").replace(/[*]/g, "");
  if (clean.length < 2) return null;
  return { key: `q:${clean.toLowerCase()}`, label: `“${clean}”`, text: clean, matcher: matcherFor([clean.toLowerCase()]) };
}

export function sentences(paragraph) {
  return paragraph.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/);
}
