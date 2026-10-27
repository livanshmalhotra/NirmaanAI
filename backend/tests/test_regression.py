"""Existing features still work after the workspace / generator changes."""
import unittest

from tests.helpers import fresh_client

from state.store import store


class ExistingFeatureTests(unittest.TestCase):
    def setUp(self):
        self.client = fresh_client()

    def test_chat_adds_a_floor(self):
        r = self.client.post("/api/chat", json={"message": "add a floor"}).json()
        self.assertEqual(len(r["updatedState"]["floors"]), 1)
        self.assertIsNotNone(r["seismicDemand"])

    def test_batch_rooms_still_arranged(self):
        self.client.post("/api/chat", json={"message": "add a floor"})
        rooms = [{"type": "bedroom", "area_sqft": 140}, {"type": "kitchen", "area_sqft": 90},
                 {"type": "bathroom", "area_sqft": 45}, {"type": "living", "area_sqft": 200}]
        r = self.client.post("/api/rooms/batch", json={"floor_number": 1, "rooms": rooms, "arrange": True}).json()
        self.assertTrue(all(rm["x"] is not None for rm in r["floors"][0]["rooms"]))
        too_big = self.client.post("/api/rooms/batch", json={"floor_number": 1, "rooms": [{"type": "bedroom", "area_sqft": 5000}]})
        self.assertEqual(too_big.status_code, 400)

    def test_boq_and_seismic_demand(self):
        self.client.post("/api/chat", json={"message": "add a floor"})
        boq = self.client.get("/api/estimate/boq").json()
        self.assertGreater(boq["total"], 0)
        sd = self.client.get("/api/analysis/seismic-demand").json()
        self.assertEqual(sd["zone"], "II")  # Bengaluru, IS 1893 zone map
        self.assertGreater(sd["demand"], 0)

    def test_main_requests_never_need_a_draft(self):
        self.assertIsNone(store.draft())
        self.assertEqual(self.client.get("/api/state").status_code, 200)
        self.assertEqual(self.client.get("/api/state", headers={"X-Workspace": "main"}).status_code, 200)

    def test_delete_a_floor(self):
        for _ in range(3):
            self.client.post("/api/chat", json={"message": "add a floor"})
        self.client.post("/api/rooms/batch", json={"floor_number": 3, "rooms": [{"type": "office", "area_sqft": 120}]})
        cost = self.client.get("/api/state").json()["budget"]["used"]
        r = self.client.delete("/api/floors/2")
        self.assertEqual(r.status_code, 200, r.text)
        floors = r.json()["floors"]
        self.assertEqual([f["number"] for f in floors], [1, 2])
        self.assertEqual(floors[1]["rooms"][0]["type"], "office")  # the old Floor 3 moved down
        self.assertLess(r.json()["budget"]["used"], cost)
        self.assertEqual(self.client.delete("/api/floors/9").status_code, 404)

    def test_delete_middle_floor_keeps_shapes_supported(self):
        for _ in range(3):
            self.client.post("/api/chat", json={"message": "add a floor"})
        self.assertEqual(self.client.patch("/api/floors/3", json={"shape": "l-shape"}).status_code, 200)
        self.assertEqual(self.client.patch("/api/floors/2", json={"shape": "l-shape"}).status_code, 200)
        r = self.client.delete("/api/floors/2")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([f["shape"] for f in r.json()["floors"]], ["rectangle", "l-shape"])
        self.assertEqual(self.client.delete("/api/floors/2").status_code, 200)  # top floor
        self.assertEqual(len(self.client.get("/api/state").json()["floors"]), 1)

    def test_delete_floor_in_the_draft_only(self):
        self.client.post("/api/design/generate", json={"prompt": "2bhk on two floors"})
        self.assertEqual(self.client.delete("/api/floors/2", headers={"X-Workspace": "draft"}).status_code, 200)
        self.assertEqual(len(store.draft().floors), 1)
        self.assertEqual(store.main().floors, [])

    def test_ml_structural_risk(self):
        r = self.client.get("/api/analysis/structural-risk").json()
        self.assertIsNone(r["risk"])  # nothing to score yet
        self.assertTrue(r["model_loaded"])
        chat = self.client.post("/api/chat", json={"message": "add a floor"}).json()
        self.assertIsNotNone(chat["structuralRisk"])
        self.assertTrue(0 <= chat["structuralRisk"] <= 1)
        r = self.client.get("/api/analysis/structural-risk").json()
        self.assertAlmostEqual(r["risk"], chat["structuralRisk"])
        # Taller buildings score higher
        for _ in range(3):
            self.client.post("/api/chat", json={"message": "add a floor"})
        self.assertGreater(self.client.get("/api/analysis/structural-risk").json()["risk"], r["risk"])

    def test_reset_in_main_keeps_the_draft(self):
        self.client.post("/api/design/generate", json={"prompt": "1bhk"})
        self.assertIsNotNone(store.draft())
        self.client.post("/api/reset")
        self.assertIsNotNone(store.draft())


if __name__ == "__main__":
    unittest.main()
