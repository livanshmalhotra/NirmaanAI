"""
Shared test setup. Run from backend/:

    python -m unittest discover -s tests -t .

The state store is kept in memory (BUILDING_STATE_FILE=""), Gemini is off
unless a test stubs it, and nothing here touches the network.
"""
import os

os.environ["BUILDING_STATE_FILE"] = ""
os.environ["GEMINI_API_KEY"] = ""  # load_dotenv() never overrides a variable that is already set

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402
from state.store import store  # noqa: E402

DRAFT = {"X-Workspace": "draft"}

FAKE_CLIMATE = {
    "nbc_zone": "Warm-Humid", "month_counts": {"Warm-Humid": 8}, "months": [], "hot_day_c": 34.0,
    "record_gust_kmh": 60, "annual_rain_mm": 1000, "period": "test",
}


async def fake_site_profile(lat, lon, in_karnataka=True, with_climate=True):
    """Stands in for services.site_profile.site_profile (Open-Meteo) in tests."""
    return {"lat": lat, "lon": lon, "climate": dict(FAKE_CLIMATE), "elevation_m": 900, "errors": []}


async def no_climate_site_profile(lat, lon, in_karnataka=True, with_climate=True):
    return {"lat": lat, "lon": lon, "climate": None, "elevation_m": None,
            "errors": ["Climate archive unavailable (ConnectError)"]}


def fresh_client(budget: int = 6_000_000, floor_area: int = 1200, plot_area: int = 2400) -> TestClient:
    store.reset()
    store.set_draft(None)
    client = TestClient(app)
    res = client.post("/api/configure", json={"total_budget": budget, "shape": "rectangle",
                                              "floor_area_sqft": floor_area, "plot_area_sqft": plot_area})
    assert res.status_code == 200, res.text
    return client
