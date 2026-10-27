"""
Build backend/data/lifecycle/lifecycle_data.json — the maintenance, service-life,
envelope and water figures the lifecycle analysis uses — from official
documents only.

    pip install pymupdf httpx
    python scripts/build_lifecycle_data.py

Unlike the hazard maps, these figures are printed in tables whose layout
doesn't survive text extraction reliably, so each value is listed here with
the exact words printed next to it (`proof`). The build downloads every
document, then checks that each proof appears on the cited PDF page
(whitespace-insensitive) and that the value is part of it. A figure whose
proof isn't on its page stops the build — nothing reaches the JSON unverified.

Sources (downloaded into backend/data/lifecycle/sources/, git-ignored):
  cpwd    CPWD Maintenance Manual 2019 (Central Public Works Department, MoHUA)
  ens     Eco-Niwas Samhita 2018 Part I: Building Envelope (Bureau of Energy
          Efficiency, Ministry of Power) — the residential energy code
  is1172  IS 1172:1993 Code of Basic Requirements for Water Supply, Drainage
          and Sanitation (BIS, via Public.Resource.Org)
  cgwb    Manual on Artificial Recharge of Ground Water (Central Ground Water
          Board, Ministry of Water Resources, 2007)
"""
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import httpx
import pymupdf

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "lifecycle"
SRC_DIR = DATA_DIR / "sources"
OUT = DATA_DIR / "lifecycle_data.json"
USER_AGENT = "ArchiMindAI/1.0 (building planner; https://github.com/Annsishh/HackWoman)"

SOURCES = {
    "cpwd": {
        "url": "https://ndmc.gov.in/departments/Departments/Finance/nodal_cell/CPWD%20Maintenance%20Manual%202019.pdf",
        "title": "CPWD Maintenance Manual 2019",
        "publisher": "Central Public Works Department, Ministry of Housing & Urban Affairs, Govt. of India",
    },
    "ens": {
        "url": "https://policy.asiapacificenergy.org/sites/default/files/Eco-Niwas%20Samhita%202018%20"
               "%28Energy%20Conservation%20Building%20Code%20for%20Residential%20Buildings%29.pdf",
        "title": "Eco-Niwas Samhita 2018 (Energy Conservation Building Code for Residential Buildings), Part I: Building Envelope",
        "publisher": "Bureau of Energy Efficiency, Ministry of Power, Govt. of India",
    },
    "is1172": {
        "url": "https://law.resource.org/pub/in/bis/S03/is.1172.1993.pdf",
        "title": "IS 1172:1993 Code of Basic Requirements for Water Supply, Drainage and Sanitation",
        "publisher": "Bureau of Indian Standards (via Public.Resource.Org)",
    },
    "cgwb": {
        "url": "https://cgwb.gov.in/old_website/documents/Manual%20on%20Artificial%20Recharge%20of%20Ground%20Water.pdf",
        "title": "Manual on Artificial Recharge of Ground Water (2007)",
        "publisher": "Central Ground Water Board, Ministry of Water Resources, Govt. of India",
    },
}

# ── The figures, each with the words printed beside it ──────────────────────
# (doc, pdf_page, proof, value). `value` must appear inside `proof`.

FINISHING = {  # CPWD Annexure 10, residential column: years between applications
    "interior_paint": ("cpwd", 57, "Painting with plastic/Acrylic Emulsion paint, Acrylic Synthetic enamel paint, "
                       "Oil bound distemper etc. 3 years", 3, "Annexure 10, item A1"),
    "exterior_emulsion": ("cpwd", 57, "Painting external surface with exterior emulsion or equivalent paint. 5 years",
                          5, "Annexure 10, item A2"),
    "exterior_cement_paint": ("cpwd", 57, "Painting external surface with water proofing cement paint. 3 years",
                              3, "Annexure 10, item A3"),
    "tank_cleaning": ("cpwd", 57, "Cleaning and disinfecting of water storage/distribution tanks, water mains. 6 months",
                      0.5, "Annexure 10, item A4"),
    "sewer_cleaning": ("cpwd", 57, "Cleaning of Manholes/Gully chambers and flushing of building sewers. 1 year",
                       1, "Annexure 10, item A5"),
    "storm_drain_cleaning": ("cpwd", 57, "Cleaning of storm water drains. 1 year", 1, "Annexure 10, item A6"),
    "wood_polish": ("cpwd", 57, "Polishing wooden doors/windows with spirit polish/synthetic acrylic polish. 3 years",
                    3, "Annexure 10, item A8"),
    "electrical_cleaning": ("cpwd", 57, "Cleaning Electrical installation, fans etc. 1 year", 1, "Annexure 10, item A9"),
}

LIVES = {  # years a component is expected to last before replacement / renewal
    "roof_waterproofing": ("cpwd", 23, "supposed to last satisfactorily only for a period of about ten years",
                           10, "Chapter 5 (i)", "ten"),
    "gi_pipes": ("cpwd", 23, "The life of GI pipes shall be considered as 25 years", 25, "Chapter 5 (v)", "25"),
    "lawn_regrassing": ("cpwd", 23, "Re-grassing of lawns/grass plots in 5 to 6 years without replacement of earth",
                        5, "Chapter 5 (vi)", "5 to 6"),
    "conduit_wiring": ("cpwd", 76, "Conduit wiring non-coastal area 20", 20, "Annexure 15 A1", "20"),
    "conduit_wiring_coastal": ("cpwd", 76, "Conduit wiring coastal area 15", 15, "Annexure 15 A2", "15"),
    "indoor_luminaires": ("cpwd", 76, "Indoor luminaries 5", 5, "Annexure 15 A6", "5"),
    "ceiling_fan": ("cpwd", 76, "Ceiling Fan AC 15", 15, "Annexure 15 B1", "15"),
    "exhaust_fan": ("cpwd", 76, "Exhaust Fan AC 6", 6, "Annexure 15 B2", "6"),
    "water_pump": ("cpwd", 76, "Water supply Pump( Centrifugal) 10", 10, "Annexure 15 F5", "10"),
    "split_ac": ("cpwd", 76, "Window type / Split type Air-conditioning units with air cooled condensers 7",
                 7, "Annexure 15 G5", "7"),
    "solar_pv": ("cpwd", 77, "Solar PV Panel 25", 25, "Annexure 15 K4", "25"),
}

BUILDING_LIFE = {  # expected economic life of the whole building
    "rcc_framed": ("cpwd", 23, "RCC Framed construction 75 years", 75, "Chapter 5"),
    "load_bearing": ("cpwd", 23, "Load bearing construction 55 years", 55, "Chapter 5"),
}

CHECKS = [  # preventive inspections, CPWD Chapter 7.2
    ("cpwd", 28, "Cleanliness of roofs, inlet of rain water pipes, khurra, chajja/sunshade top, outlet of "
                 "rain water pipes, plinth protection and drains minimum twice a year and particularly before monsoon"),
    ("cpwd", 28, "Cracks on gola and top of parapet"),
    ("cpwd", 28, "Leakage from terrace tanks"),
    ("cpwd", 28, "Rusting of GI pipes and fittings showing seepage"),
]

# CPWD Annexure 2 / 2(A): maintenance yardsticks, Rs per m² of plinth area per year
YARDSTICK = ("cpwd", 40, "Type I to V and above 126.30 54.65 34.80 57.65 80.50")
YARDSTICK_DATE = ("cpwd", 40, "As on 01.04.2019")
ELECTRICAL_YARDSTICK = ("cpwd", 42, "Type I to IV 69 77 83 93")

ENS = {
    "retv_max": ("ens", 20, "shall comply with the maximum RETV19 of 15 W/m2", 15, "cl. 3.4.2"),
    "uroof_max": ("ens", 19, "shall comply with the maximum Uroof value of 1.2 W/m2.K", 1.2, "cl. 3.3.2"),
}
ENS_COEFFS = ("ens", 22, "Composite 6.06 1.85 68.99 Hot-Dry 6.06 1.85 68.99 Warm-Humid 5.15 1.31 65.21 "
                         "Temperate 3.38 0.37 63.69", "Table 3")
ENS_FILMS = ("ens", 34, "Rsi (m2.K/W) 0.13 0.17 0.10 Rse (m2.K/W) 0.04 0.04 0.04", "Table 6")
ENS_WFR = ("ens", 18, "Composite 12.50 Hot-Dry 10.00 Warm-Humid 16.66 Temperate 12.50 Cold 8.33", "Table 1")
ENS_ORIENT = ("ens", 39, "North (337.6˚–22.5˚) 0.550 0.659 North-east (22.6˚–67.5˚) 0.829 0.906 "
                         "East (67.6˚–112.5˚) 1.155 1.155 South-east (112.6˚–157.5˚) 1.211 1.125 "
                         "South (157.6˚–202.5˚) 1.089 0.966 South-west (202.6˚–247.5˚) 1.202 1.124 "
                         "West (247.6˚–292.5˚) 1.143 1.156 North-west (292.6˚–337.5˚) 0.821 0.908", "Table 9")
ENS_MATERIALS = {  # Table 7: density kg/m³, conductivity W/m.K
    "burnt_clay_brick": ("ens", 35, "Solid burnt clay brick 1920 0.980", "Solid burnt clay brick (1920 kg/m³)", 0.980),
    "fly_ash_brick": ("ens", 35, "Fly ash brick 1650 0.856", "Fly ash brick", 0.856),
    "concrete_block": ("ens", 35, "Solid concrete block 25/50 2427 1.396", "Solid concrete block 25/50", 1.396),
    "aac_block": ("ens", 35, "Aerated autoclaved concrete (AAC) block 642 0.184", "AAC block", 0.184),
    "rcc": ("ens", 35, "Reinforced concrete cement (RCC) 2288 1.580", "Reinforced concrete (RCC)", 1.580),
    "cement_plaster": ("ens", 35, "Cement plaster 1762 0.721", "Cement plaster", 0.721),
}
ENS_PUF = ("ens", 54, "Polyurethane foam (PUF) 0.040 0.023 1.739", "Example 1, Table 21")
ENS_GLASS = ("ens", 51, "Single clear glass with SHGC 0.80, VLT 85%, and U-value 5.80 W/m2.K", "Example 1, Table 17")

WATER = {
    "lphd_20k_100k": ("is1172", 7, "20 000 to 100 to 150 lphd 100,000", "Table 1 (2)"),
    "lphd_over_100k": ("is1172", 7, "populationabove 100 000 150 to 200 lphd", "Table 1 (3)"),
    "flushing": ("is1172", 7, "45 litres per head per day may be taken for flushing requirements", "cl. 4.1.1"),
}
CGWB_RUNOFF = ("cgwb", 130, "GI Sheet 0.9 Asbestos 0.8 Tiled 0.75 Concrete 0.7", "Table 7.2")
CGWB_FORMULA = ("cgwb", 130, "Water available (in litres) = Annual rainfall (in mm) x Roof area (in sq.m) x "
                             "Runoff Coefficient", "Section 7.2.7.1")


# ── Download and verify ──────────────────────────────────────────────────────

def download(name: str, url: str) -> tuple[Path, dict]:
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    path = SRC_DIR / f"{name}.pdf"
    if not path.exists():
        print(f"Downloading {url}")
        with httpx.Client(follow_redirects=True, timeout=240, headers={"User-Agent": USER_AGENT}) as client:
            for attempt in range(3):
                try:
                    res = client.get(url)
                    res.raise_for_status()
                    path.write_bytes(res.content)
                    break
                except httpx.HTTPError as exc:
                    if attempt == 2:
                        # Some government servers send an incomplete certificate chain that the
                        # OS trust store completes but Python's doesn't; curl still verifies it
                        print(f"  {exc!r}; trying the system curl")
                        if subprocess.run(["curl", "-sSLf", "-m", "300", "-o", str(path), url]).returncode:
                            path.unlink(missing_ok=True)
                            raise SystemExit(f"Couldn't download {url}")
                        break
                    print(f"  retrying after {exc!r}")
                    time.sleep(5)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return path, {"url": url, "sha256": digest, "retrieved": date.fromtimestamp(path.stat().st_mtime).isoformat()}


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


class Docs:
    def __init__(self):
        self.pages: dict[str, list[str]] = {}
        self.meta: dict[str, dict] = {}
        self.failures: list[str] = []

    def load(self) -> None:
        for name, src in SOURCES.items():
            path, meta = download(name, src["url"])
            self.pages[name] = [_flat(p.get_text()) for p in pymupdf.open(path)]
            self.meta[name] = {**meta, "title": src["title"], "publisher": src["publisher"]}

    def cite(self, doc: str, page: int, proof: str, value=None) -> dict:
        """Check `proof` is printed on `page` (and holds `value`); return the citation."""
        text = self.pages[doc][page - 1] if 0 < page <= len(self.pages[doc]) else ""
        if _flat(proof) not in text:
            found = [i + 1 for i, t in enumerate(self.pages[doc]) if _flat(proof) in t]
            self.failures.append(f"{doc} p.{page}: {proof!r} not found" + (f" (it is on page(s) {found})" if found else ""))
        if value is not None and str(value) not in proof:
            self.failures.append(f"{doc} p.{page}: value {value!r} isn't in its proof {proof!r}")
        return {"doc": doc, "pdf_page": page, "printed": proof}


def numbers(text: str) -> list[float]:
    return [float(n) for n in re.findall(r"\d+\.\d+|\d+", text)]


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    d = Docs()
    d.load()

    finishing = {}
    for key, (doc, page, proof, years, ref) in FINISHING.items():
        shown = "6 months" if years == 0.5 else f"{years:g} year"
        finishing[key] = {"years": years, "ref": ref, **d.cite(doc, page, proof, shown)}
    lives = {}
    for key, (doc, page, proof, years, ref, printed) in LIVES.items():
        lives[key] = {"years": years, "ref": ref, **d.cite(doc, page, proof, printed)}
    building_life = {k: {"years": y, "ref": ref, **d.cite(doc, page, proof, y)}
                     for k, (doc, page, proof, y, ref) in BUILDING_LIFE.items()}
    checks = [{"text": proof, **d.cite(doc, page, proof)} for doc, page, proof in CHECKS]

    service, annual, sp_0_20, sp_21_40, sp_40 = numbers(YARDSTICK[2].split("above", 1)[1])
    yardstick = {
        "category": "Residential buildings, Type I to V and above",
        "service_charges": service, "annual_repair": annual,
        "special_repair": [{"from_year": 0, "to_year": 20, "rate": sp_0_20},
                           {"from_year": 21, "to_year": 40, "rate": sp_21_40},
                           {"from_year": 41, "to_year": None, "rate": sp_40}],
        "unit": "Rs per m² of plinth area per year", "ref": "Annexure 2",
        "as_on": "2019-04-01", **d.cite(*YARDSTICK),
        "basis_date": d.cite(*YARDSTICK_DATE),
    }
    e0, e10, _, _ = numbers(ELECTRICAL_YARDSTICK[2].split("IV", 1)[1])
    electrical = {"category": "Residential Type I to IV, concentrated groups", "age_0_10": e0, "age_over_10": e10,
                  "unit": "Rs per m² per year", "ref": "Annexure 2(A)", "as_on": "2019-04-01", **d.cite(*ELECTRICAL_YARDSTICK)}

    ens = {k: {"value": v, "ref": ref, **d.cite(doc, page, proof, v)} for k, (doc, page, proof, v, ref) in ENS.items()}
    doc, page, proof, ref = ENS_COEFFS
    coeffs = {}
    for zone, a, b, c in re.findall(r"([A-Z][a-z]+(?:-[A-Z][a-z]+)?) (\d+\.\d+) (\d+\.\d+) (\d+\.\d+)", proof):
        coeffs[zone] = {"a": float(a), "b": float(b), "c": float(c)}
    ens["retv_coefficients"] = {"value": coeffs, "ref": ref, **d.cite(doc, page, proof)}
    doc, page, proof, ref = ENS_FILMS
    rsi_wall, rsi_roof, _, rse_wall, rse_roof, _ = numbers(proof.replace("m2.K/W", ""))
    ens["surface_films"] = {"value": {"rsi_wall": rsi_wall, "rsi_roof": rsi_roof, "rse_wall": rse_wall, "rse_roof": rse_roof},
                            "ref": ref, **d.cite(doc, page, proof)}
    doc, page, proof, ref = ENS_WFR
    ens["wfr_min_pct"] = {"value": {z: float(v) for z, v in re.findall(r"([A-Z][a-z]+(?:-[A-Z][a-z]+)?) (\d+\.\d+)", proof)},
                          "ref": ref, **d.cite(doc, page, proof)}
    doc, page, proof, ref = ENS_ORIENT
    orient = []
    for _, lo, hi, north, south in re.findall(r"([A-Za-z-]+) \((\d+\.\d)˚–(\d+\.\d)˚\) (\d\.\d+) (\d\.\d+)", proof):
        orient.append({"from_deg": float(lo), "to_deg": float(hi), "lat_ge_23_5": float(north), "lat_lt_23_5": float(south)})
    ens["orientation_factors"] = {"value": orient, "ref": ref, **d.cite(doc, page, proof)}
    ens["materials"] = {k: {"label": label, "k": k_val, "ref": "Table 7", **d.cite(doc_, page_, proof_, k_val)}
                        for k, (doc_, page_, proof_, label, k_val) in ENS_MATERIALS.items()}
    doc, page, proof, ref = ENS_PUF
    ens["materials"]["puf"] = {"label": "Polyurethane foam (PUF) insulation", "k": 0.023, "thickness_m": 0.040,
                               "ref": ref, **d.cite(doc, page, proof, 0.023)}
    doc, page, proof, ref = ENS_GLASS
    ens["single_clear_glass"] = {"value": {"u": 5.80, "shgc": 0.80, "vlt": 0.85}, "ref": ref, **d.cite(doc, page, proof)}

    water = {}
    for key, (doc, page, proof, ref) in WATER.items():
        water[key] = {"ref": ref, **d.cite(doc, page, proof)}
    water["lphd_20k_100k"]["value"] = [100, 150]
    water["lphd_over_100k"]["value"] = [150, 200]
    water["flushing"]["value"] = 45
    doc, page, proof, ref = CGWB_RUNOFF
    water["runoff_coefficients"] = {
        "value": {k.lower().replace(" ", "_"): float(v) for k, v in re.findall(r"([A-Z][A-Za-z ]+?) (\d\.\d+)", proof)},
        "ref": ref, **d.cite(doc, page, proof)}
    water["harvest_formula"] = {"ref": CGWB_FORMULA[3], **d.cite(*CGWB_FORMULA[:3])}

    if d.failures:
        raise SystemExit("Verification failed — nothing written:\n  " + "\n  ".join(d.failures))

    data = {
        "generated": date.today().isoformat(),
        "generator": "backend/scripts/build_lifecycle_data.py",
        "note": "Every figure was checked against the printed text of the cited PDF page (`printed`).",
        "sources": d.meta,
        "finishing_periodicity": finishing,
        "component_life": lives,
        "building_life": building_life,
        "inspections": checks,
        "cpwd_yardstick": yardstick,
        "cpwd_electrical_yardstick": electrical,
        "ens": ens,
        "water": water,
    }
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUT}: {len(finishing)} periodicities, {len(lives)} component lives, "
          f"{len(coeffs)} RETV climate rows, {len(orient)} orientation factors — all verified")


if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit(__doc__)
    main()
