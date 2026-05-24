"""
nemlig_unit_price.py

Find the cheapest product per unit on nemlig.com for a given search query.

Usage:
    python nemlig_unit_price.py "mælk"
    python nemlig_unit_price.py "havregryn" --top 10
    python nemlig_unit_price.py "smør" --debug

Set credentials at the top of the file or via environment variables:
    NEMLIG_EMAIL / NEMLIG_PASSWORD

Dependencies:
    pip install requests
"""

import argparse
import json
import os
import re
import sys
from typing import Optional

import requests

# ── Credentials ────────────────────────────────────────────────────────────────
NEMLIG_EMAIL    = os.environ.get("NEMLIG_EMAIL", "YOUR_EMAIL_HERE")
NEMLIG_PASSWORD = os.environ.get("NEMLIG_PASSWORD", "YOUR_PASSWORD_HERE")

# ── Endpoints ──────────────────────────────────────────────────────────────────
BASE_SITE        = "https://www.nemlig.com"
ANTIFORGERY_URL  = f"{BASE_SITE}/webapi/user/antiforgerytoken"
TOKEN_URL        = f"{BASE_SITE}/webapi/user/token"
LOGIN_URL        = f"{BASE_SITE}/webapi/user/login"
SEARCH_URL       = "https://webapi.prod.knl.nemlig.it/api/v2/search"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": BASE_SITE + "/",
    "Origin":  BASE_SITE,
}

# ── Unit helpers ───────────────────────────────────────────────────────────────
UNIT_TO_BASE = {
    "kg": 1000, "g": 1,
    "l": 1000, "liter": 1000, "litre": 1000,
    "dl": 100, "cl": 10, "ml": 1,
}
UNIT_DISPLAY = {
    "kg": "kr/kg", "g": "kr/kg",
    "l": "kr/l", "liter": "kr/l", "litre": "kr/l",
    "dl": "kr/l", "cl": "kr/l", "ml": "kr/l",
}

SIZE_RE = re.compile(
    r"(\d+[,.]?\d*)\s*x\s*(\d+[,.]?\d*)\s*(kg|g|l|dl|cl|ml|liter|litre)\b"
    r"|(\d+[,.]?\d*)\s*(kg|g|l|dl|cl|ml|liter|litre)\b",
    re.IGNORECASE,
)


# ── Auth ───────────────────────────────────────────────────────────────────────
def login(email: str, password: str) -> requests.Session:
    session = requests.Session()
    session.headers.update(HEADERS)

    # Step 1: get antiforgery token
    try:
        r = session.get(ANTIFORGERY_URL, timeout=10)
        r.raise_for_status()
        af_token = r.json().get("antiForgeryToken") or r.json().get("token") or r.text.strip().strip('"')
    except Exception as e:
        print(f"Step 1 (antiforgery) failed: {e}")
        sys.exit(1)

    session.headers["X-XSRF-TOKEN"] = af_token
    session.headers["RequestVerificationToken"] = af_token

    # Step 2: get bearer token
    try:
        r = session.post(TOKEN_URL, json={"username": email, "password": password}, timeout=10)
        r.raise_for_status()
        data = r.json()
        bearer = data.get("access_token") or data.get("accessToken") or data.get("token")
    except Exception as e:
        print(f"Step 2 (token) failed: {e}")
        print("Response:", r.text[:300])
        sys.exit(1)

    if bearer:
        session.headers["Authorization"] = f"Bearer {bearer}"

    # Step 3: login
    try:
        r = session.post(LOGIN_URL, json={"username": email, "password": password}, timeout=10)
        r.raise_for_status()
    except Exception as e:
        print(f"Step 3 (login) failed: {e}")
        print("Response:", r.text[:300])
        sys.exit(1)

    return session


# ── Search ─────────────────────────────────────────────────────────────────────
def fetch_products(session: requests.Session, query: str, page_size: int = 48) -> tuple:
    params = {
        "query": query,
        "pageSize": page_size,
        "pageIndex": 0,
    }
    try:
        r = session.get(SEARCH_URL, params=params, timeout=10)
        r.raise_for_status()
        data = r.json()
    except requests.exceptions.HTTPError as e:
        print(f"Search request failed: {e}")
        print("Response:", r.text[:300])
        sys.exit(1)
    except ValueError:
        print("Could not parse JSON from search response.")
        sys.exit(1)

    # Find products wherever they are nested
    products = _extract_products(data)
    return products, data


def _extract_products(data) -> list:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []

    # Direct hit
    for key in ("products", "Products", "items", "Items", "results", "Results"):
        val = data.get(key)
        if isinstance(val, list) and val:
            return val

    # One level deep
    for v in data.values():
        if isinstance(v, dict):
            result = _extract_products(v)
            if result:
                return result
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    result = _extract_products(item)
                    if result:
                        return result
    return []


# ── Unit price calculation ─────────────────────────────────────────────────────
def parse_pack_size(name: str) -> tuple[Optional[float], Optional[str]]:
    matches = SIZE_RE.findall(name)
    if not matches:
        return None, None

    # Last match
    m = matches[-1]
    if m[0]:  # multipack: qty1 x qty2 unit
        qty1 = float(m[0].replace(",", "."))
        qty2 = float(m[1].replace(",", "."))
        unit = m[2].lower()
        total_base = qty1 * qty2 * UNIT_TO_BASE[unit]
    else:      # simple: qty unit
        qty = float(m[3].replace(",", "."))
        unit = m[4].lower()
        total_base = qty * UNIT_TO_BASE[unit]

    display_qty = total_base / 1000  # to kg or l
    return display_qty, UNIT_DISPLAY.get(unit, f"kr/{unit}")


def extract_price(product: dict) -> Optional[float]:
    for path in [
        ("pricing", "currentPrice"), ("pricing", "price"), ("pricing", "salesPrice"),
        ("price", "currentPrice"), ("price", "price"), ("price", "value"),
        ("Price",), ("price",), ("currentPrice",), ("CurrentPrice",), ("salesPrice",),
    ]:
        obj = product
        for key in path:
            obj = obj.get(key) if isinstance(obj, dict) else None
        if obj is not None:
            try:
                return float(obj)
            except (TypeError, ValueError):
                continue
    return None


def compute_unit_price(product: dict) -> Optional[dict]:
    name = (product.get("displayName") or product.get("DisplayName")
            or product.get("name") or product.get("Name") or "")
    price = extract_price(product)
    if not price or price <= 0:
        return None

    # Use API-provided unit price if available
    pricing = product.get("pricing") or product.get("price") or {}
    if isinstance(pricing, dict):
        up = pricing.get("unitPrice") or pricing.get("pricePerUnit") or pricing.get("UnitPrice")
        ul = pricing.get("unitPriceLabel") or pricing.get("unitLabel") or pricing.get("UnitLabel")
        if up and ul:
            return {"name": name, "price": price,
                    "unit_price": float(up), "unit_label": ul,
                    "url": BASE_SITE + (product.get("relativeUrl") or product.get("RelativeUrl") or "")}

    qty, label = parse_pack_size(name)
    if qty and qty > 0:
        return {"name": name, "price": price,
                "unit_price": price / qty, "unit_label": label,
                "url": BASE_SITE + (product.get("relativeUrl") or product.get("RelativeUrl") or "")}
    return None


# ── Output ─────────────────────────────────────────────────────────────────────
def search_cheapest(session: requests.Session, query: str, top_n: int = 5, debug: bool = False) -> None:
    print(f"\nSearching nemlig.com for: '{query}'\n")
    products, raw = fetch_products(session, query)

    if debug:
        print("Top-level keys:", list(raw.keys()) if isinstance(raw, dict) else type(raw))
        if products:
            print("\nFirst product:\n", json.dumps(products[0], indent=2, ensure_ascii=False))
        else:
            print("No products found. Full response (truncated):")
            print(json.dumps(raw, indent=2, ensure_ascii=False)[:2000])
        return

    if not products:
        print("No products returned. Run with --debug to inspect the response.")
        return

    ranked, skipped = [], 0
    for p in products:
        result = compute_unit_price(p)
        if result:
            ranked.append(result)
        else:
            skipped += 1

    if not ranked:
        print(f"Could not compute unit price for any of the {len(products)} products.")
        print("Run with --debug to inspect product field names.")
        return

    ranked.sort(key=lambda x: x["unit_price"])

    print(f"{'#':<4} {'Unit price':<20} {'Pack price':<12} Product")
    print("-" * 85)
    for i, item in enumerate(ranked[:top_n], 1):
        print(f"{i:<4} {item['unit_price']:>7.2f} {item['unit_label']:<12} "
              f"{item['price']:>7.2f} kr   {item['name'][:55]}")

    print(f"\nSkipped {skipped}/{len(products)} products (no parseable price or size).")
    print(f"\nCheapest: {ranked[0]['name']}")
    print(f"URL:      {ranked[0]['url']}")


# ── CLI ────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Find cheapest per unit on nemlig.com")
    parser.add_argument("query", help="Search term, e.g. 'mælk'")
    parser.add_argument("--top", type=int, default=5, metavar="N", help="Show top N results (default: 5)")
    parser.add_argument("--email",    default=NEMLIG_EMAIL)
    parser.add_argument("--password", default=NEMLIG_PASSWORD)
    parser.add_argument("--debug", action="store_true", help="Print raw API response and exit")
    args = parser.parse_args()

    if not args.email or not args.password or args.email == "YOUR_EMAIL_HERE":
        print("Set NEMLIG_EMAIL and NEMLIG_PASSWORD at the top of the script or via env vars.")
        sys.exit(1)

    session = login(args.email, args.password)
    search_cheapest(session, args.query, top_n=args.top, debug=args.debug)


if __name__ == "__main__":
    main()