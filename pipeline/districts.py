"""Rules mapping a contest's jurisdiction to a King County GIS district.

A match is {"layer": <key>, "value": <attribute value>} or {"layer": "all"}.
Layer keys correspond to LAYERS in site/app.js, which queries King County GIS at the
voter's address. None means we can't place the contest yet; the site shows it as
"may be on your ballot".
"""
import re

COUNTYWIDE_JURISDICTIONS = {"county", "supreme court", "court of appeals, division 1, district 1"}
JUDICIAL_DISTRICTS = {"northeast": "NE", "southeast": "SE", "southwest": "SW", "west": "W", "shoreline": "SH"}


def match_for(contest):
    title = contest["title"].lower()
    juris = contest["jurisdiction"].lower()

    if title.startswith("statewide") or juris in COUNTYWIDE_JURISDICTIONS:
        return {"layer": "all"}
    if m := re.fullmatch(r"congressional district (\d+)", juris):
        return {"layer": "cong", "value": m.group(1)}
    if m := re.fullmatch(r"legislative district (\d+)", juris):
        return {"layer": "leg", "value": m.group(1)}
    if m := re.fullmatch(r"county council district no\. (\d+)", juris):
        return {"layer": "kcc", "value": m.group(1)}
    if m := re.fullmatch(r"(\w+) electoral district", juris):
        return {"layer": "jud", "value": JUDICIAL_DISTRICTS[m.group(1)]}
    if m := re.fullmatch(r"seattle city council district (\d+)", juris):
        return {"layer": "scc", "value": f"SCC{m.group(1)}"}
    if m := re.search(r"school district no\. (\d+)", title):
        return {"layer": "sch", "value": m.group(1)}
    if m := re.search(r"fire protection district no\. (\d+)", title):
        return {"layer": "fire", "value": m.group(1)}
    if m := re.fullmatch(r"city of (.+)", juris):
        return {"layer": "city", "value": m.group(1).title().replace("Seatac", "SeaTac")}
    if juris == "king county cemetery district no. 1":
        # Not in King County GIS. Its measure describes the Vashon Cemetery and island residents,
        # so approximate it with the Vashon Island School District boundary.
        return {"layer": "sch", "value": "402", "approx": True}
    if m := re.match(r"city of (.+?) - proposition", title):
        return {"layer": "city", "value": m.group(1).title().replace("Seatac", "SeaTac")}
    return None


def display_title(contest):
    """Make bare titles like "Judge Position No. 1" say which court they're for."""
    title, juris = contest["title"], contest["jurisdiction"]
    low = juris.lower()
    if low == "county":
        return f"King County {title}", "King County"
    if low.endswith("electoral district"):
        return f"District Court {title}", f"King County District Court, {juris}"
    if low == "supreme court":
        return f"Supreme Court {title}", "Washington State Supreme Court"
    if low.startswith("court of appeals"):
        return f"Court of Appeals {title}", juris
    if low == "city of seattle" and title.startswith("Municipal Court"):
        return f"Seattle {title}", "City of Seattle"
    if low.startswith("seattle city council"):
        return f"Seattle City {title}", juris
    if low.startswith("county council district"):
        return title.replace("Metropolitan ", ""), juris
    return title, juris
