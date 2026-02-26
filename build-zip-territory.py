#!/usr/bin/env python3
"""
Build Ohio zip → natural gas utility lookup table.

Uses the HUD USPS ZIP-County crosswalk and known county-utility mappings.
For split-service counties (like Cuyahoga), we assign based on the majority
utility or use more granular zip-level knowledge.

Sources:
- County-utility mapping from PUCO/utility service territory documentation
- ZIP-county crosswalk from HUD or Census
"""

import json
import csv
import urllib.request
import ssl
import io
import sys
from collections import Counter

# Ohio's 4 Energy Choice natural gas utilities and their service counties
# Sources: PUCO service territory maps, utility websites
# Note: Some counties are split between utilities

# Enbridge Gas Ohio (formerly Dominion East Ohio) - Territory 1
# Serves northeast Ohio
ENBRIDGE_COUNTIES = [
    "Ashland", "Ashtabula", "Carroll", "Columbiana", "Coshocton",
    "Geauga", "Harrison", "Holmes", "Jefferson", "Knox",
    "Lake", "Lorain", "Mahoning", "Medina", "Morrow",
    "Portage", "Richland", "Stark", "Summit", "Trumbull",
    "Tuscarawas", "Wayne",
    # Parts of these counties
    "Belmont", "Cuyahoga", "Erie", "Guernsey", "Huron",
]

# Columbia Gas of Ohio - Territory 8
# Largest utility, serves central, southern, and parts of NE Ohio
COLUMBIA_COUNTIES = [
    "Adams", "Allen", "Auglaize", "Athens",
    "Brown", "Butler", "Champaign", "Clark", "Clinton",
    "Crawford", "Darke", "Defiance", "Delaware", "Fairfield",
    "Fayette", "Franklin", "Fulton", "Gallia", "Greene",
    "Hancock", "Hardin", "Henry", "Highland", "Hocking",
    "Jackson", "Lawrence", "Licking", "Logan", "Lucas",
    "Madison", "Marion", "Meigs", "Mercer", "Miami",
    "Monroe", "Montgomery", "Morgan", "Muskingum",
    "Noble", "Ottawa", "Paulding", "Perry", "Pickaway",
    "Pike", "Preble", "Putnam", "Ross", "Sandusky",
    "Scioto", "Seneca", "Shelby", "Union",
    "Van Wert", "Vinton", "Warren", "Washington",
    "Williams", "Wood", "Wyandot",
    # Parts of these counties (shared with others)
    "Belmont", "Cuyahoga", "Erie", "Guernsey", "Huron",
    "Hamilton",  # some areas
    "Clermont",  # some areas
]

# Duke Energy Ohio - Territory 10
# Southwest Ohio (Cincinnati area)
DUKE_COUNTIES = [
    "Hamilton", "Clermont", "Butler", "Warren",
]

# CenterPoint Energy Ohio (formerly Vectren) - Territory 11
# Dayton/west-central Ohio area
CENTERPOINT_COUNTIES = [
    "Montgomery", "Greene", "Miami", "Preble", "Darke",
    "Auglaize", "Mercer", "Shelby", "Clark", "Champaign",
    "Logan",
]

# Counties that are split between utilities — we need zip-level resolution
SPLIT_COUNTIES = {
    "Cuyahoga", "Belmont", "Erie", "Guernsey", "Huron",
    "Hamilton", "Clermont", "Butler", "Warren",
    "Montgomery", "Greene", "Miami", "Preble", "Darke",
    "Auglaize", "Mercer", "Shelby", "Clark", "Champaign", "Logan",
}

# Known zip-level overrides for split counties
# Enbridge zips in Cuyahoga County (Cleveland proper and east side)
ENBRIDGE_ZIPS = {
    # Cuyahoga - Enbridge serves Cleveland, east suburbs
    "44101", "44102", "44103", "44104", "44105", "44106", "44107", "44108",
    "44109", "44110", "44111", "44112", "44113", "44114", "44115", "44116",
    "44117", "44118", "44119", "44120", "44121", "44122", "44123", "44124",
    "44125", "44126", "44127", "44128", "44131", "44132", "44133", "44135",
    "44137", "44138", "44139", "44140", "44141", "44142", "44143", "44144",
    "44145", "44146", "44147", "44149",
    # Lake County
    "44060", "44077", "44092", "44094", "44095",
    # Geauga
    "44021", "44022", "44023", "44024", "44040", "44046", "44062", "44065", "44072",
    # Ashtabula
    "44003", "44004", "44010", "44030", "44032", "44041", "44047", "44048",
    "44068", "44076", "44082", "44084", "44085", "44093",
    # Summit (Akron area)
    "44201", "44203", "44210", "44212", "44216", "44217", "44221", "44222",
    "44223", "44224", "44230", "44236", "44237", "44240", "44241", "44243",
    "44250", "44260", "44262", "44264", "44266", "44272", "44278", "44281",
    "44286", "44301", "44302", "44303", "44304", "44305", "44306", "44307",
    "44308", "44309", "44310", "44311", "44312", "44313", "44314", "44319",
    "44320", "44321", "44333",
    # Portage
    "44201", "44231", "44234", "44240", "44241", "44243", "44255", "44260",
    "44264", "44265", "44266", "44272", "44285", "44288",
    # Stark (Canton area)
    "44601", "44606", "44608", "44612", "44613", "44614", "44618", "44626",
    "44630", "44632", "44634", "44640", "44641", "44643", "44645", "44646",
    "44647", "44648", "44650", "44651", "44652", "44657", "44662", "44666",
    "44669", "44670", "44672", "44676", "44677", "44685", "44688", "44689",
    "44691", "44695", "44697", "44699", "44702", "44703", "44704", "44705",
    "44706", "44707", "44708", "44709", "44710", "44714", "44718", "44720",
    "44721",
    # Mahoning (Youngstown area)
    "44401", "44402", "44403", "44405", "44406", "44410", "44411", "44412",
    "44413", "44416", "44417", "44418", "44420", "44422", "44425", "44428",
    "44429", "44430", "44431", "44436", "44437", "44438", "44440", "44442",
    "44443", "44444", "44446", "44449", "44450", "44451", "44452", "44454",
    "44455", "44460", "44470", "44471", "44473", "44481", "44482", "44484",
    "44485", "44486", "44490", "44491", "44492", "44493",
    "44501", "44502", "44503", "44504", "44505", "44506", "44507", "44509",
    "44510", "44511", "44512", "44514", "44515",
    # Trumbull
    "44401", "44402", "44403", "44404", "44405", "44410", "44417", "44418",
    "44420", "44425", "44428", "44429", "44430", "44436", "44437", "44438",
    "44440", "44442", "44443", "44444", "44446", "44449", "44450", "44451",
    "44452", "44453", "44454", "44470", "44471", "44473", "44481", "44482",
    "44484", "44485", "44486", "44490", "44491",
    # Columbiana
    "43901", "43902", "43903", "43906", "43907", "43908", "43910", "43912",
    "43913", "43915", "43917", "43920", "43925", "43926", "43928", "43930",
    "43931", "43932", "43933", "43934", "43935", "43938", "43939", "43940",
    "43942", "43943", "43944", "43945", "43946", "43947", "43948", "43950",
    "43951", "43952", "43953", "43961", "43963", "43964", "43967", "43968",
    "43970", "43971", "43972", "43973", "43974", "43976", "43977", "43981",
    "43983", "43984", "43985", "43986", "43988",
    "44408", "44413", "44415", "44423", "44427", "44432", "44441", "44445",
    "44455", "44460", "44492", "44493",
    # Carroll
    "44609", "44615", "44619", "44620", "44621", "44643", "44651", "44665",
    # Jefferson
    "43901", "43903", "43906", "43907", "43908", "43910", "43912", "43913",
    "43920", "43925", "43926", "43928", "43930", "43931", "43932", "43933",
    "43934", "43935", "43938", "43942", "43943", "43944", "43950", "43951",
    "43952", "43953", "43961", "43963", "43964", "43967", "43968", "43970",
    "43971", "43972", "43976", "43977", "43981", "43983", "43984", "43986",
    "43988",
    # Harrison
    "43902", "43906", "43915", "43917", "43939", "43940", "43945", "43946",
    "43947", "43948", "43973", "43974", "43985",
    "44672", "44695", "44699",
    # Lorain
    "44001", "44011", "44012", "44028", "44035", "44036", "44039", "44044",
    "44049", "44050", "44052", "44053", "44054", "44055", "44074", "44089",
    "44090",
    # Medina
    "44203", "44212", "44215", "44217", "44230", "44233", "44235", "44253",
    "44254", "44256", "44258", "44273", "44274", "44275", "44276", "44280",
    "44281",
    # Wayne
    "44201", "44214", "44216", "44217", "44230", "44235", "44270", "44273",
    "44276", "44287",
    "44606", "44618", "44627", "44628", "44632", "44636", "44637", "44638",
    "44644", "44645", "44659", "44660", "44666", "44667", "44676", "44677",
    "44681", "44689", "44691",
    # Tuscarawas
    "44610", "44612", "44615", "44621", "44622", "44624", "44628", "44629",
    "44637", "44643", "44651", "44656", "44663", "44671", "44678", "44681",
    "44682", "44683",
    # Holmes
    "44610", "44611", "44617", "44618", "44624", "44627", "44628", "44633",
    "44637", "44638", "44654", "44660", "44661", "44681", "44687", "44689",
    # Coshocton
    "43812", "43822", "43824", "43832", "43836", "43837", "43843", "43844",
    "43845",
    # Knox
    "43005", "43006", "43011", "43014", "43019", "43022", "43028", "43037",
    "43048", "43050", "43055", "43056", "43061", "43080", "43081", "43082",
    # Richland (Mansfield)
    "44813", "44822", "44826", "44843", "44862", "44875", "44901", "44902",
    "44903", "44904", "44905", "44906", "44907",
    # Ashland
    "44805", "44807", "44817", "44838", "44842", "44844", "44848", "44859",
    "44864", "44866", "44874", "44878", "44880",
    # Morrow
    "43302", "43315", "43316", "43317", "43320", "43321", "43325", "43332",
    "43334", "43338", "43341", "43342", "43344", "43345",
    # Erie (partial)
    "44811", "44814", "44824", "44836", "44839", "44846", "44870", "44871",
    # Huron (partial)
    "44811", "44815", "44826", "44827", "44837", "44839", "44841", "44843",
    "44845", "44846", "44847", "44851", "44854", "44857", "44865", "44867",
    "44875", "44878", "44880", "44882", "44887", "44889",
}

# Duke Energy zips (Hamilton County/Cincinnati, Clermont, Butler, Warren)
DUKE_ZIPS = {
    # Hamilton County (Cincinnati)
    "45001", "45002", "45011", "45013", "45014", "45015", "45030", "45033",
    "45034", "45036", "45039", "45040", "45041", "45042", "45044", "45050",
    "45051", "45052", "45053", "45054", "45055", "45056", "45062", "45063",
    "45064", "45065", "45066", "45067", "45068", "45069", "45070", "45071",
    "45099", "45101", "45102", "45103", "45106", "45107", "45110", "45111",
    "45112", "45113", "45115", "45118", "45119", "45120", "45121", "45122",
    "45130", "45131", "45132", "45133", "45135", "45140", "45142", "45144",
    "45145", "45146", "45147", "45148", "45150", "45152", "45153", "45154",
    "45155", "45156", "45157", "45158", "45160", "45162", "45164", "45166",
    "45167", "45168", "45169", "45171", "45172", "45174", "45176",
    "45201", "45202", "45203", "45204", "45205", "45206", "45207", "45208",
    "45209", "45210", "45211", "45212", "45213", "45214", "45215", "45216",
    "45217", "45218", "45219", "45220", "45221", "45222", "45223", "45224",
    "45225", "45226", "45227", "45228", "45229", "45230", "45231", "45232",
    "45233", "45234", "45235", "45236", "45237", "45238", "45239", "45240",
    "45241", "45242", "45243", "45244", "45245", "45246", "45247", "45248",
    "45249", "45250", "45251", "45252", "45253", "45254", "45255",
}

# CenterPoint Energy zips (Dayton/Springfield area)
CENTERPOINT_ZIPS = {
    # Montgomery County (Dayton)
    "45301", "45302", "45303", "45304", "45305", "45306", "45307", "45308",
    "45309", "45310", "45311", "45312", "45314", "45315", "45316", "45317",
    "45318", "45319", "45320", "45321", "45322", "45323", "45324", "45325",
    "45326", "45327", "45328", "45330", "45331", "45332", "45333", "45334",
    "45335", "45337", "45338", "45339", "45340", "45341", "45342", "45343",
    "45344", "45345", "45346", "45347", "45348", "45349", "45350", "45351",
    "45352", "45353", "45354", "45356", "45358", "45359", "45360", "45361",
    "45362", "45363", "45365", "45367", "45368", "45369", "45370", "45371",
    "45372", "45373", "45374", "45377", "45378", "45380", "45381", "45382",
    "45383", "45384", "45385", "45387", "45388", "45389", "45390",
    "45399", "45400", "45401", "45402", "45403", "45404", "45405", "45406",
    "45407", "45408", "45409", "45410", "45412", "45413", "45414", "45415",
    "45416", "45417", "45418", "45419", "45420", "45421", "45422", "45423",
    "45424", "45425", "45426", "45427", "45428", "45429", "45430", "45431",
    "45432", "45433", "45434", "45435", "45436", "45437", "45439", "45440",
    "45441", "45448", "45449", "45454", "45458", "45459", "45469", "45470",
    "45475", "45479", "45481", "45482", "45490",
    # Clark County (Springfield)
    "45501", "45502", "45503", "45504", "45505", "45506",
    # Champaign County (Urbana)
    "43040", "43044", "43045", "43060", "43070", "43072", "43078",
    "43084", "43311", "43319",
}


def get_ohio_zips():
    """Get all Ohio zip codes from Census or a reliable source."""
    # Use the Census ZCTA to state relationship file
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    # Try to get Ohio zips from a simple source
    url = "https://raw.githubusercontent.com/scpike/us-state-county-zip/master/geo-data.csv"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, context=ctx, timeout=30)
        data = resp.read().decode("utf-8")
        reader = csv.DictReader(io.StringIO(data))
        ohio_zips = {}
        for row in reader:
            if row.get("state_fips") == "39" or row.get("state") == "OH":
                zipcode = row.get("zipcode", "").strip()
                county = row.get("county", "").strip()
                if zipcode and county and zipcode.isdigit() and len(zipcode) == 5:
                    ohio_zips[zipcode] = county
        if ohio_zips:
            print(f"Got {len(ohio_zips)} Ohio zips from geo-data.csv", file=sys.stderr)
            return ohio_zips
    except Exception as e:
        print(f"geo-data.csv failed: {e}", file=sys.stderr)

    # Fallback: generate Ohio zip ranges
    print("Using Ohio zip code ranges as fallback", file=sys.stderr)
    ohio_zips = {}
    # Ohio zip codes are generally in these ranges:
    # 43001-45999
    for z in range(43001, 46000):
        ohio_zips[str(z)] = ""
    return ohio_zips


def assign_utility(zipcode, county=""):
    """Assign a utility to a zip code."""
    # Check explicit zip overrides first
    if zipcode in CENTERPOINT_ZIPS:
        return "centerpoint"
    if zipcode in DUKE_ZIPS:
        return "duke"
    if zipcode in ENBRIDGE_ZIPS:
        return "enbridge"

    # Fall back to county-level assignment
    county_clean = county.replace(" County", "").strip()

    # Priority: more specific utilities first
    if county_clean in ["Hamilton", "Clermont"]:
        return "duke"
    if county_clean in ["Montgomery", "Greene", "Miami", "Preble", "Darke",
                         "Auglaize", "Mercer", "Shelby", "Clark", "Champaign",
                         "Logan"]:
        # These are split between CenterPoint and Columbia
        # CenterPoint mainly serves Dayton metro area
        z = int(zipcode)
        if 45300 <= z <= 45510:
            return "centerpoint"
        return "columbia"

    if county_clean in ["Butler", "Warren"]:
        z = int(zipcode)
        if 45001 <= z <= 45099:
            return "duke"
        return "columbia"

    # Enbridge counties (NE Ohio)
    enbridge_only = {"Ashtabula", "Columbiana", "Geauga", "Harrison",
                     "Jefferson", "Lake", "Mahoning", "Medina", "Portage",
                     "Stark", "Summit", "Trumbull", "Tuscarawas", "Wayne",
                     "Carroll", "Holmes", "Coshocton", "Knox", "Lorain",
                     "Ashland", "Richland", "Morrow"}
    if county_clean in enbridge_only:
        return "enbridge"

    if county_clean == "Cuyahoga":
        # Cuyahoga is mostly Enbridge, with some Columbia in SW corner
        z = int(zipcode)
        if zipcode in ("44129", "44130", "44134", "44136"):
            return "columbia"
        return "enbridge"

    if county_clean in ["Erie", "Huron"]:
        return "enbridge"  # Mostly Enbridge

    if county_clean in ["Belmont", "Guernsey"]:
        return "enbridge"  # Mostly Enbridge

    # Everything else is Columbia Gas
    return "columbia"


def main():
    ohio_zips = get_ohio_zips()

    result = {}
    counts = Counter()

    for zipcode in sorted(ohio_zips.keys()):
        county = ohio_zips[zipcode]
        utility = assign_utility(zipcode, county)
        if utility:
            result[zipcode] = utility
            counts[utility] += 1

    # If we didn't get county data, do a pure zip-range approach
    if not any(ohio_zips.values()):
        print("No county data available, using zip-range heuristics", file=sys.stderr)
        result = {}
        counts = Counter()

        # Get valid Ohio zips from a simpler approach
        # Ohio zips: 43001-45999 (roughly)
        # Let's just use the known zip sets + county-based ranges
        all_zips = set()
        all_zips.update(ENBRIDGE_ZIPS)
        all_zips.update(DUKE_ZIPS)
        all_zips.update(CENTERPOINT_ZIPS)

        # Add remaining Ohio zips as Columbia (the default/largest)
        for z in range(43001, 46000):
            zs = str(z).zfill(5)
            all_zips.add(zs)

        for zipcode in sorted(all_zips):
            utility = None
            if zipcode in CENTERPOINT_ZIPS:
                utility = "centerpoint"
            elif zipcode in DUKE_ZIPS:
                utility = "duke"
            elif zipcode in ENBRIDGE_ZIPS:
                utility = "enbridge"
            else:
                utility = "columbia"
            result[zipcode] = utility
            counts[utility] += 1

    # Add any zips from our override sets that aren't in the result
    for z in ENBRIDGE_ZIPS:
        if z not in result and z.isdigit() and len(z) == 5:
            result[z] = "enbridge"
            counts["enbridge"] += 1
    for z in DUKE_ZIPS:
        if z not in result and z.isdigit() and len(z) == 5:
            result[z] = "duke"
            counts["duke"] += 1
    for z in CENTERPOINT_ZIPS:
        if z not in result and z.isdigit() and len(z) == 5:
            result[z] = "centerpoint"
            counts["centerpoint"] += 1

    print(f"\nResults: {len(result)} zip codes mapped", file=sys.stderr)
    for utility, count in sorted(counts.items()):
        print(f"  {utility}: {count}", file=sys.stderr)

    # Write output
    output_path = "/Users/jimfano/.openclaw/workspace/ohio-rate-watch/zip-territory.json"
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2, sort_keys=True)
    print(f"\nWritten to {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
