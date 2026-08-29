"""Generate a parity fixture from the desktop backend.

The web app re-implements the money rules in JavaScript. Rather than
trust that port, this runs the *real* Python functions over a spread of
inputs and writes what they produce; tests.html then asserts the JS
agrees case for case.

Run:  python tools/gen_fixture.py      (writes tests/fixture.json)
"""

from __future__ import annotations

import json
import os
import sys

# Import the desktop backend in place — the point is to test against the
# shipping implementation, not a copy of it.
HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.abspath(os.path.join(HERE, "..", "..", "tokotally"))
sys.path.insert(0, DESKTOP)

from backend.constants import PRICE_MULTIPLIER          # noqa: E402
from backend.dates import format_date_display, parse_user_date  # noqa: E402
from backend.discounts import discount_factor           # noqa: E402
from backend.money import PPN_RATE, line_total, sale_total  # noqa: E402
from backend.money import PPN_RATE, sale_total          # noqa: E402

DISCOUNTS = [
    "", "0", "10", "10+5", "10+5+3", "50+50", "100", "12,5", "12.5",
    "  10 + 5  ", "abc", "10+abc+5", "+", "++", "10+", "0+0",
    # Negative percents: a surcharge rather than a discount, plus the
    # malformed shapes the field allows on the way to a valid one.
    "-10", "-12,5", "-10+5", "10+-5", "-10+-5", "-", "--", "5-3", "+-",
]

DATES = [
    "", "  ", "2026-08-04", "04/08/2026", "4/8/2026", "04-08-2026",
    "04/08/26", "04-08-26", "31/02/2026", "29/02/2024", "29/02/2023",
    "1/1/00", "1/1/68", "1/1/69", "1/1/99", "13/13/2026", "0/1/2026",
    "not a date", "2026/08/04", "2026-13-01", "31/12/1999",
]

ISO_DATES = ["", "2026-08-04", "1999-12-31", "2024-02-29", "garbage"]

# (qty, price, discount) -> line total, covering the x1000 rule, chained
# discounts, negatives (returns) and fractional input.
LINES = [
    (1, 0, ""), (1, 80, ""), (3, 80, ""), (2, 50, "10+5"),
    (1, 1, ""), (0, 100, ""), (-2, 50, ""), (2.5, 40, ""),
    (1, 12.5, ""), (4, 50, "10+5"), (1, 100, "100"), (3, 80, "12,5"),
    # A negative percent marks the line up.
    (1, 100, "-10"), (2, 50, "-10+5"), (3, 80, "10+-5"),
]

# (lines, ppn rate) -> what the sale is worth. Each set of lines is run at
# both rates, so the tax step is pinned as well as its absence.
SALES = [
    [],
    [(1, 1646, "")],
    [(1, 80, ""), (3, 80, "")],
    [(2, 50, "10+5")],                       # taxed after discounting
    [(1, 100, "-10")],                        # ...and after a surcharge
    [(2, 50, ""), (1, 12.5, ""), (-1, 20, "")],   # includes a return
]


def main() -> int:
    fixture = {
        "priceMultiplier": PRICE_MULTIPLIER,
        "discountFactor": [
            {"input": t, "expected": discount_factor(t)} for t in DISCOUNTS
        ],
        "parseUserDate": [
            {"input": t, "expected": parse_user_date(t)} for t in DATES
        ],
        "formatDateDisplay": [
            {"input": t, "expected": format_date_display(t)} for t in ISO_DATES
        ],
        "lineTotal": [
            {
                "qty": q,
                "price": p,
                "discount": d,
                "expected": line_total({"qty": q, "price": p, "discount": d}),
            }
            for q, p, d in LINES
        ],
        "ppnRate": PPN_RATE,
        "saleTotal": [
            {
                "items": [
                    {"qty": q, "price": p, "discount": d} for q, p, d in lines
                ],
                "rate": rate,
                "expected": sale_total(
                    [{"qty": q, "price": p, "discount": d} for q, p, d in lines],
                    rate,
                ),
            }
            for lines in SALES
            for rate in (0.0, PPN_RATE)
        ],
    }

    out_dir = os.path.abspath(os.path.join(HERE, "..", "tests"))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "fixture.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh, indent=1)

    counts = {k: len(v) for k, v in fixture.items() if isinstance(v, list)}
    print(f"wrote {out_path}")
    print(f"cases: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
