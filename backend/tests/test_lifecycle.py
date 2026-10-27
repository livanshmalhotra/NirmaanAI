import unittest
from unittest import mock

from tests.helpers import DRAFT, fake_site_profile, fresh_client, no_climate_site_profile

import services.lifecycle as lifecycle
import services.sor_rates as sor
from services.lifecycle import data


def report(client, headers=None, **options):
    res = client.post("/api/lifecycle", json=options, headers=headers or {})
    assert res.status_code == 200, res.text
    return res.json()


class SourceDataTests(unittest.TestCase):
    def test_every_figure_carries_its_printed_proof(self):
        d = data()
        self.assertEqual(set(d["sources"]), {"cpwd", "ens", "is1172", "cgwb"})
        for src in d["sources"].values():
            self.assertEqual(len(src["sha256"]), 64)
        for key, entry in d["finishing_periodicity"].items():
            shown = "6 months" if entry["years"] == 0.5 else f"{entry['years']:g} year"
            self.assertIn(shown, entry["printed"], key)
        for key, entry in d["building_life"].items():
            self.assertIn(str(entry["years"]), entry["printed"], key)
        ens = d["ens"]
        self.assertEqual(ens["retv_coefficients"]["value"]["Warm-Humid"], {"a": 5.15, "b": 1.31, "c": 65.21})
        self.assertEqual(ens["retv_max"]["value"], 15)
        self.assertEqual(ens["uroof_max"]["value"], 1.2)
        self.assertEqual(len(ens["orientation_factors"]["value"]), 8)
        self.assertEqual(d["water"]["runoff_coefficients"]["value"]["concrete"], 0.7)

    def test_kpwd_maintenance_items_exist(self):
        for code in ("8.63", "8.75.1", "8.72.1", "15.2"):
            self.assertIsNotNone(sor.item(code), code)


@mock.patch.object(lifecycle, "site_profile", fake_site_profile)
class LifecycleReportTests(unittest.TestCase):
    def setUp(self):
        self.client = fresh_client()
        self.client.post("/api/design/generate", json={"prompt": "2bhk on two floors"})
        self.client.post("/api/design/draft/apply")

    def test_empty_building(self):
        self.client.post("/api/reset")
        self.assertIn("error", report(self.client))

    def test_wall_u_value_follows_the_ens_formula(self):
        r = report(self.client)
        ens = data()["ens"]
        m, films = ens["materials"], ens["surface_films"]["value"]
        expected = 1 / (films["rsi_wall"] + 2 * 0.015 / m["cement_plaster"]["k"]
                        + 9 * 0.0254 / m["burnt_clay_brick"]["k"] + films["rse_wall"])
        self.assertAlmostEqual(r["envelope"]["u_wall"], round(expected, 2), places=2)
        self.assertEqual(r["envelope"]["climate_zone"], "Warm-Humid")
        self.assertIsNotNone(r["envelope"]["retv"])

    def test_results_follow_the_design_choices(self):
        base = report(self.client)
        thick = report(self.client, exterior_wall_in=13.5)
        aac = report(self.client, wall_material="aac_block")
        insulated = report(self.client, roof_insulation=True)
        cement = report(self.client, exterior_finish="exterior_cement_paint")
        self.assertLess(thick["envelope"]["u_wall"], base["envelope"]["u_wall"])
        self.assertLess(aac["envelope"]["retv"], base["envelope"]["retv"])
        self.assertFalse(base["envelope"]["roof_ok"])
        self.assertTrue(insulated["envelope"]["roof_ok"])
        tasks = lambda r: {p["task"]: p for p in r["maintenance"]["priced"]}
        self.assertTrue(any("cement paint" in t for t in tasks(cement)))
        cement_task = next(p for t, p in tasks(cement).items() if "cement paint" in t)
        self.assertEqual(cement_task["every_years"], 3)
        self.assertEqual(cement_task["rate"], sor.item("8.72.1")["rate"])

    def test_results_follow_the_building(self):
        before = report(self.client)
        state = self.client.get("/api/state").json()
        # Add a window and a floor: glazing, RETV, paint and roof quantities change
        added = False
        for room in (rm for f in state["floors"] for rm in f["rooms"]):
            for side in ("front", "back", "left", "right"):
                if self.client.put(f"/api/rooms/{room['id']}/windows",
                                   json={"side": side, "count": 1, "width_ft": 4, "height_ft": 4}).status_code == 200:
                    added = True
                    break
            if added:
                break
        self.assertTrue(added)
        after_window = report(self.client)
        self.assertGreater(after_window["quantities"]["window_m2"], before["quantities"]["window_m2"])
        self.assertNotEqual(after_window["envelope"]["retv"], before["envelope"]["retv"])
        self.client.post("/api/chat", json={"message": "add a floor"})
        after_floor = report(self.client)
        self.assertGreater(after_floor["quantities"]["interior_paint_m2"], after_window["quantities"]["interior_paint_m2"])
        self.assertGreater(after_floor["initial_cost"], after_window["initial_cost"])

    def test_maintenance_arithmetic(self):
        r = report(self.client, horizon_years=30)
        for p in r["maintenance"]["priced"]:
            self.assertEqual(p["events"], int(30 // p["every_years"]))
            self.assertAlmostEqual(p["cost_per_event"], p["quantity"] * p["rate"], delta=p["rate"])
            self.assertAlmostEqual(p["total"], p["cost_per_event"] * p["events"], delta=p["events"])
        discounted = report(self.client, horizon_years=30, discount_pct=5)
        self.assertLess(discounted["summary"]["maintenance_priced_pv"], discounted["summary"]["maintenance_priced"])

    def test_missing_information_is_reported_not_invented(self):
        r = report(self.client)
        self.assertIn("Number of occupants", r["missing"])
        self.assertNotIn("demand_litres_per_day", r["water"])
        full = report(self.client, occupants=4, town="over_100k")
        self.assertEqual(full["water"]["demand_litres_per_day"], [600, 800])
        # CGWB: rainfall (mm) × roof (m², shown to 0.1) × 0.7 for a concrete roof
        h = full["water"]["harvest"]
        self.assertEqual(h["rain_mm"], 1000)
        self.assertAlmostEqual(h["annual_litres"], 1000 * h["roof_m2"] * 0.7, delta=1000 * 0.05 * 0.7)
        self.assertEqual(full["water"]["flushing_litres_per_year"], 4 * 45 * 365)

    def test_draft_and_comparison(self):
        self.client.post("/api/design/generate", json={"prompt": "3bhk on two floors"})
        draft = report(self.client, headers=DRAFT)
        self.assertGreater(draft["quantities"]["rooms"], 0)
        cmp = self.client.post("/api/lifecycle/compare", json={"alternatives": [
            {"label": "Mine", "design": "main", "options": {}},
            {"label": "Generated, AAC", "design": "draft", "options": {"wall_material": "aac_block"}},
        ]}).json()["alternatives"]
        self.assertEqual(len(cmp), 2)
        self.assertLess(cmp[1]["summary"]["u_wall"], cmp[0]["summary"]["u_wall"])
        bad = self.client.post("/api/lifecycle/compare", json={"alternatives": [
            {"label": "A", "options": {"horizon_years": 10}}, {"label": "B", "options": {"horizon_years": 20}}]})
        self.assertEqual(bad.status_code, 422)

    def test_invalid_options_are_rejected(self):
        self.assertEqual(self.client.post("/api/lifecycle", json={"horizon_years": 0}).status_code, 422)
        self.assertEqual(self.client.post("/api/lifecycle", json={"wall_material": "glass"}).status_code, 422)


@mock.patch.object(lifecycle, "site_profile", no_climate_site_profile)
class LifecycleWithoutClimateTests(unittest.TestCase):
    def test_climate_outage_is_shown_as_missing(self):
        client = fresh_client()
        client.post("/api/chat", json={"message": "add a floor"})
        r = report(client)
        self.assertIsNone(r["envelope"]["retv"])
        self.assertIn("climate", r["envelope"]["retv_note"])
        self.assertIsNone(r["water"]["harvest"])
        self.assertTrue(any("Climate archive unavailable" in m for m in r["missing"]))
        # Everything that doesn't need the climate is still there
        self.assertTrue(r["maintenance"]["priced"])


if __name__ == "__main__":
    unittest.main()
