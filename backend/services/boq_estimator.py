"""
Bill of Quantities from the Karnataka PWD Schedule of Rates (Buildings 2023-24, Vol 2).

How a building is priced:
  1. Shell — materials and labour from the CBRI plinth-area relations in
     Addendum II (quantity = a·A + b, A = total plinth area of all storeys),
     priced at Vol 2 basic rates, then the SR's own add-ons (1% sundries,
     1% water, 10% overhead, 10% profit — Preface item 5).
  2. Fittings the relations leave out ("water supply, plumbing … to be added
     extra", Note I): flooring per room, W.C. + wash basin + waterproofing per
     bathroom, sink per kitchen, waterproofing on every exposed roof. These are
     finished items, whose rates already include the add-ons.
  3. Regional adjustment — Vol 1 Area Specific Loading once entered, otherwise
     an interim seismic/soil/wind premium (see sor_rates.regional_adjustment).
  4. GST 18% only when Constraints.includeGst is set (SR rates exclude it).

Every line carries its SR reference and whether its rate is verified against
Vol 2 or still a placeholder for a Vol 1 / quarterly figure.
"""
from models.building import BOQBreakdown, BOQLine, BuildingState
import services.sor_rates as sor

SQFT_PER_M2 = 10.7639
_VALID_A = (30, 300)  # m², Addendum II Note I


def _area_m2(sqft: float) -> float:
    return sqft / SQFT_PER_M2


def _line(key: str, qty: float, category: str, **extra) -> BOQLine:
    r = sor.rate(key)
    qty = max(0.0, qty)  # relations go negative below their valid range
    return BOQLine(
        key=key, label=r["label"], category=category,
        qty=round(qty, 2), unit=r["unit"], rate=r["rate"],
        amount=round(qty * r["rate"]),
        ref=r.get("ref", ""), page=str(r.get("page", "")), status=r["status"],
        **extra,
    )


def _exposed_roof_m2(state: BuildingState) -> float:
    """Each floor's area not covered by the floor above (all of the top floor)."""
    floors = sorted(state.floors, key=lambda f: f.number)
    total = 0.0
    for i, floor in enumerate(floors):
        above = floors[i + 1].area_sqft if i + 1 < len(floors) else 0
        total += max(0, floor.area_sqft - above)
    return _area_m2(total)


def estimate_boq(state: BuildingState) -> BOQBreakdown:
    floors = len(state.floors)
    a_m2 = _area_m2(sum(f.area_sqft for f in state.floors))
    district_id = state.constraints.district_id
    boq = BOQBreakdown(district_id=district_id, plinth_area_m2=round(a_m2, 1), floors=floors, relation_set="none")
    if floors == 0 or a_m2 <= 0:
        boq.notes.append("No floors yet — nothing to price.")
        return boq

    # ── 1. Shell from plinth-area relations ─────────────────────────────────
    boq.relation_set = "single" if floors == 1 else "double"
    for row in sor.relations(boq.relation_set):
        category = "labour" if row["key"].endswith("_day") else "material"
        boq.lines.append(_line(row["key"], row["a"] * a_m2 + row["b"], category))

    shell = sum(l.amount for l in boq.lines)
    add_ons = sor.core()["add_ons"]
    running = shell
    for key, label in (("sundries_pct", "Sundries"), ("water_pct", "Water charges")):
        amt = round(shell * add_ons[key] / 100)
        boq.lines.append(BOQLine(key=key, label=f"{label} {add_ons[key]}%", category="add_on", qty=1, unit="LS",
                                 rate=amt, amount=amt, ref="Preface item 5", status="derived"))
        running += amt
    for key, label in (("overhead_pct", "Overhead"), ("profit_pct", "Contractor's profit")):
        amt = round(running * add_ons[key] / 100)
        boq.lines.append(BOQLine(key=key, label=f"{label} {add_ons[key]}%", category="add_on", qty=1, unit="LS",
                                 rate=amt, amount=amt, ref="Preface item 5", status="derived"))
        running += amt

    # ── 2. Fittings and finishes the relations exclude ──────────────────────
    rooms = [r for f in state.floors for r in f.rooms]
    room_m2 = _area_m2(sum(r.area_sqft for r in rooms))
    bathrooms = [r for r in rooms if r.type == "bathroom"]
    kitchens = sum(r.type == "kitchen" for r in rooms)
    if room_m2:
        boq.lines.append(_line("vitrified_floor_m2", room_m2, "fitting"))
    if bathrooms:
        boq.lines.append(_line("wc_each", len(bathrooms), "fitting"))
        boq.lines.append(_line("wash_basin_each", len(bathrooms), "fitting"))
        boq.lines.append(_line("wet_area_wp_m2", _area_m2(sum(r.area_sqft for r in bathrooms)), "fitting"))
    if kitchens:
        boq.lines.append(_line("kitchen_sink_each", kitchens, "fitting"))
    boq.lines.append(_line("roof_wp_m2", _exposed_roof_m2(state), "fitting"))

    boq.subtotal = sum(l.amount for l in boq.lines)

    # ── 3. Regional adjustment ──────────────────────────────────────────────
    region = sor.regional_adjustment(district_id)
    boq.regional_pct, boq.regional_status = region["pct"], region["status"]
    total = boq.subtotal
    if region["pct"]:
        amt = round(boq.subtotal * region["pct"] / 100)
        boq.lines.append(BOQLine(key="regional", label=f"{region['label']} {region['pct']:g}%", category="regional",
                                 qty=1, unit="LS", rate=amt, amount=amt, ref=region["ref"], status=region["status"]))
        total += amt

    # ── 4. GST ──────────────────────────────────────────────────────────────
    boq.include_gst = state.constraints.includeGst
    if boq.include_gst:
        gst_pct = sor.core()["gst_pct"]
        amt = round(total * gst_pct / 100)
        boq.lines.append(BOQLine(key="gst", label=f"GST {gst_pct}%", category="tax", qty=1, unit="LS",
                                 rate=amt, amount=amt, ref="SR rates exclude GST (Preface item 3)", status="derived"))
        total += amt
    boq.total = total

    # ── Caveats ─────────────────────────────────────────────────────────────
    boq.placeholders_used = sum(l.status == "placeholder" for l in boq.lines)
    if floors > 2:
        boq.approximate = True
        boq.notes.append(f"{floors} storeys: Addendum II has no load-bearing relation above two storeys, "
                         "so the double-storey relation is extended.")
    if not _VALID_A[0] <= a_m2 <= _VALID_A[1]:
        boq.approximate = True
        boq.notes.append(f"Plinth area {a_m2:.0f} m² is outside the 30–300 m² range the relations were fitted on.")
    if boq.placeholders_used:
        boq.notes.append(f"{boq.placeholders_used} rate(s) are placeholders (cement, steel, sand, aggregate, wages) "
                         "until KPWD Vol 1 / quarterly rates are entered.")
    if region["status"] != "verified":
        boq.notes.append("Regional adjustment is an interim estimate until Vol 1 Area Specific Loading is entered.")
    boq.notes.append("Excludes electrical wiring, water supply/drainage piping, formwork (Vol 1) and lift charges.")
    return boq


def next_floor_cost(state: BuildingState) -> int:
    """What one more floor (same area as the current top floor, or the configured floor area) adds to the BOQ."""
    from models.building import Floor
    area = state.floors[-1].area_sqft if state.floors else state.constraints.floorAreaSqft
    probe = state.model_copy(deep=True)
    probe.floors.append(Floor(id="probe", number=len(state.floors) + 1, area_sqft=area))
    return max(0, estimate_boq(probe).total - estimate_boq(state).total)


def room_cost(state: BuildingState, area_sqft: int) -> int:
    """Flooring for a general room of this size, with the regional adjustment (rooms add no shell cost)."""
    base = _area_m2(area_sqft) * sor.rate("vitrified_floor_m2")["rate"]
    return round(base * (1 + sor.regional_adjustment(state.constraints.district_id)["pct"] / 100))


def cost_buckets(boq: BOQBreakdown) -> tuple[int, int, int]:
    """Split a BOQ into the legacy (concrete, steel, glass) buckets; concrete takes everything else."""
    steel = sum(l.amount for l in boq.lines if l.key == "steel_kg")
    glass = sum(l.amount for l in boq.lines if l.key == "glass_m2")
    return boq.total - steel - glass, steel, glass
