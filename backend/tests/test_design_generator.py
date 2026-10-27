import asyncio
import json
import unittest
from unittest import mock

from tests.helpers import DRAFT, fresh_client

import services.gemini_client as gemini_client
from services.design_generator import DesignBrief, interpret_brief, parse_brief_rules
from state.store import store


class RuleParserTests(unittest.TestCase):
    def rooms(self, brief: DesignBrief) -> dict:
        return {r.type: r.count for r in brief.rooms}

    def test_bhk_uses_the_app_presets(self):
        self.assertEqual(self.rooms(parse_brief_rules("3BHK")),
                         {"bedroom": 3, "living": 1, "kitchen": 1, "dining": 1, "bathroom": 2})

    def test_explicit_counts_override_the_preset(self):
        b = parse_brief_rules("2bhk with 3 bathrooms and a study")
        self.assertEqual(self.rooms(b)["bathroom"], 3)
        self.assertEqual(self.rooms(b)["office"], 1)

    def test_room_sizes_are_kept(self):
        b = parse_brief_rules("2 bedrooms of 180 sq ft, a 100 sqft kitchen and a hall")
        sizes = {r.type: r.area_sqft for r in b.rooms}
        self.assertEqual(sizes["bedroom"], 180)
        self.assertEqual(sizes["kitchen"], 100)
        self.assertIsNone(sizes["living"])

    def test_floors(self):
        self.assertEqual(parse_brief_rules("2bhk G+1").floors, 2)
        self.assertEqual(parse_brief_rules("2bhk duplex").floors, 2)
        self.assertEqual(parse_brief_rules("2bhk on three floors").floors, 3)
        self.assertIsNone(parse_brief_rules("2bhk, 1200 sq ft floor area").floors)

    def test_budget(self):
        self.assertEqual(parse_brief_rules("2bhk budget 45 lakh").budget_inr, 4_500_000)
        self.assertEqual(parse_brief_rules("2bhk within 1.2 crore").budget_inr, 12_000_000)
        self.assertIsNone(parse_brief_rules("2bhk on 2 l-shaped floors").budget_inr)
        self.assertEqual(parse_brief_rules("2bhk on 2 l-shaped floors").shape, "l-shape")

    def test_plot_parking_garden(self):
        b = parse_brief_rules("2bhk on a 30x40 plot with parking for 2 cars and a garden")
        self.assertEqual(b.plot_area_sqft, 1200)
        self.assertEqual(b.parking_cars, 2)
        self.assertTrue(b.garden)
        self.assertEqual(parse_brief_rules("2bhk with car parking").parking_cars, 1)

    def test_nothing_is_invented(self):
        b = parse_brief_rules("I want a nice house")
        self.assertEqual(b.rooms, [])
        self.assertIsNone(b.budget_inr)
        self.assertIsNone(b.floors)


class InterpretTests(unittest.TestCase):
    def test_without_ai_key_the_rules_are_used(self):
        brief, parser, notes = asyncio.run(interpret_brief("2bhk"))
        self.assertEqual(parser, "rules")
        self.assertTrue(any("No AI key" in n for n in notes))

    def test_gemini_reading_is_used_and_validated(self):
        reply = json.dumps({"rooms": [{"type": "bedroom", "count": 2}, {"type": "kitchen", "count": 1}], "floors": 1})
        with mock.patch.object(gemini_client, "available", return_value=True), \
                mock.patch.object(gemini_client, "generate", mock.AsyncMock(return_value=reply)):
            brief, parser, _ = asyncio.run(interpret_brief("two bedrooms and a kitchen"))
        self.assertEqual(parser, "gemini")
        self.assertEqual(brief.floors, 1)

    def test_unusable_gemini_reply_falls_back(self):
        bad = json.dumps({"rooms": [{"type": "spaceship", "count": 1}]})
        with mock.patch.object(gemini_client, "available", return_value=True), \
                mock.patch.object(gemini_client, "generate", mock.AsyncMock(return_value=bad)):
            brief, parser, notes = asyncio.run(interpret_brief("2bhk"))
        self.assertEqual(parser, "rules")
        self.assertEqual(len(brief.rooms), 4)
        self.assertTrue(notes)

    def test_gemini_outage_falls_back(self):
        with mock.patch.object(gemini_client, "available", return_value=True), \
                mock.patch.object(gemini_client, "generate", mock.AsyncMock(return_value=None)):
            _, parser, notes = asyncio.run(interpret_brief("2bhk"))
        self.assertEqual(parser, "rules")
        self.assertTrue(any("couldn't be used" in n for n in notes))


class GenerateEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = fresh_client()

    def test_feasible_brief_makes_a_valid_draft_and_leaves_the_building_alone(self):
        r = self.client.post("/api/design/generate",
                             json={"prompt": "3BHK on two floors with parking for 1 car and a garden"}).json()
        self.assertTrue(r["feasible"], r["reasons"])
        ev = r["evaluation"]
        self.assertTrue(ev["valid"], ev["issues"])
        self.assertEqual(ev["floors"], 2)
        self.assertEqual(ev["rooms"], 8)
        self.assertEqual(ev["unplaced"], [])
        self.assertLessEqual(ev["cost"], ev["budget"])
        self.assertIn("Budget", " ".join(r["from_setup"]))  # budget wasn't in the brief
        # The draft is a real building state…
        draft = self.client.get("/api/state", headers=DRAFT).json()
        self.assertEqual(len(draft["floors"]), 2)
        self.assertTrue(all(room["x"] is not None for f in draft["floors"] for room in f["rooms"]))
        self.assertEqual({f["type"] for f in draft["site"]["features"]}, {"parking", "garden"})
        # …and the user's building is untouched
        self.assertEqual(self.client.get("/api/state").json()["floors"], [])

    def test_stated_sizes_are_respected(self):
        r = self.client.post("/api/design/generate", json={"prompt": "1 bedroom of 200 sq ft, a kitchen and a bathroom"}).json()
        self.assertTrue(r["feasible"], r["reasons"])
        draft = store.draft()
        bed = next(rm for f in draft.floors for rm in f.rooms if rm.type == "bedroom")
        self.assertGreaterEqual(bed.area_sqft, 200)

    def test_form_fields_override_the_text(self):
        r = self.client.post("/api/design/generate", json={"prompt": "2bhk on two floors", "overrides": {"floors": 1}}).json()
        self.assertTrue(r["feasible"], r["reasons"])
        self.assertEqual(r["chosen"]["floors"], 1)

    def test_over_budget_brief_is_refused_with_reasons(self):
        r = self.client.post("/api/design/generate", json={"prompt": "4BHK on 3 floors, budget 5 lakh"}).json()
        self.assertFalse(r["feasible"])
        self.assertTrue(any("Over budget" in x for x in r["reasons"]), r["reasons"])
        self.assertIsNone(store.draft())

    def test_rooms_that_cannot_fit_are_refused(self):
        r = self.client.post("/api/design/generate",
                             json={"prompt": "6 bedrooms of 400 sq ft on 1 floor"}).json()
        self.assertFalse(r["feasible"])
        self.assertTrue(r["reasons"])
        self.assertIsNone(store.draft())

    def test_incomplete_brief_asks_instead_of_guessing(self):
        r = self.client.post("/api/design/generate", json={"prompt": "something nice please"}).json()
        self.assertFalse(r["feasible"])
        self.assertTrue(r["missing"])
        self.assertEqual(r["searched"], 0)

    def test_plot_smaller_than_floor_area_is_explained(self):
        r = self.client.post("/api/design/generate", json={"prompt": "2bhk on a 30x40 plot"}).json()
        self.assertFalse(r["feasible"])
        self.assertTrue(any("Built-up area per floor" in m for m in r["missing"]))

    def test_short_prompt_is_rejected(self):
        self.assertEqual(self.client.post("/api/design/generate", json={"prompt": "x"}).status_code, 422)


class DraftWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.client = fresh_client()
        r = self.client.post("/api/design/generate", json={"prompt": "2bhk"}).json()
        self.assertTrue(r["feasible"], r["reasons"])

    def test_editor_routes_edit_the_draft_only(self):
        draft = self.client.get("/api/state", headers=DRAFT).json()
        room = draft["floors"][0]["rooms"][0]
        res = self.client.patch(f"/api/rooms/{room['id']}", json={"name": "Study"}, headers=DRAFT)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(store.draft().floors[0].rooms[0].name, "Study")
        self.assertEqual(store.main().floors, [])
        # The re-check reflects the edit
        info = self.client.get("/api/design/draft").json()
        self.assertTrue(info["exists"])
        self.assertEqual(info["state"]["floors"][0]["rooms"][0]["name"], "Study")

    def test_apply_makes_it_the_building(self):
        res = self.client.post("/api/design/draft/apply")
        self.assertEqual(res.status_code, 200, res.text)
        main = self.client.get("/api/state").json()
        self.assertEqual(len(main["floors"]), 1)
        self.assertEqual(main["history"][-1]["action"], "apply_generated_design")
        self.assertIsNone(store.draft())
        self.assertFalse(self.client.get("/api/design/draft").json()["exists"])

    def test_invalid_draft_cannot_be_applied(self):
        res = self.client.post("/api/chat", json={"message": "set budget to 1 lakh"}, headers=DRAFT)
        self.assertEqual(res.status_code, 200, res.text)
        res = self.client.post("/api/design/draft/apply")
        self.assertEqual(res.status_code, 400)
        self.assertIn("Over budget", res.json()["detail"])
        self.assertEqual(store.main().floors, [])

    def test_discard(self):
        self.assertEqual(self.client.delete("/api/design/draft").status_code, 200)
        self.assertIsNone(store.draft())
        self.assertEqual(self.client.get("/api/state", headers=DRAFT).status_code, 409)
        self.assertEqual(self.client.post("/api/design/draft/apply").status_code, 409)

    def test_unknown_workspace_is_rejected(self):
        self.assertEqual(self.client.get("/api/state", headers={"X-Workspace": "other"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
