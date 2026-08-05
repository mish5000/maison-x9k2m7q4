#!/usr/bin/env python3
"""Pre-deploy integrity checks for the PRIVEE static site.

Every commit to main is a release that reaches installed devices, so the cheap
structural mistakes are worth catching mechanically. Standard library only --
no install step, runs anywhere python3 does.

    python3 tools/validate.py

Exits non-zero and prints every failure it found (not just the first).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Keys look like "london|restaurants|0".
VENUE_KEY = re.compile(r"^[a-z0-9]+\|[a-z]+\|\d+$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The line-up scraper's own vocabulary (scripts/lineups/README.md in the
# anthropic-daily repo): "high" for ticketing/RA/official-calendar sources,
# "med" for a single social post or aggregator. The app renders "med" with an
# "unconfirmed" tag, so an unrecognised value silently loses that badge.
CONFIDENCE = {"high", "med"}

failures: list[str] = []
warnings: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load_json(name: str):
    path = ROOT / name
    if not path.exists():
        fail(f"{name}: missing")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{name}: not valid JSON -- {exc}")
        return None


def check_venue_keys(name: str, data: dict) -> None:
    """Shared shape: {"generated": ..., "venues": {"<city>|<cat>|<n>": {...}}}."""
    if not isinstance(data, dict):
        fail(f"{name}: top level must be an object")
        return
    if "generated" not in data:
        fail(f"{name}: missing 'generated' timestamp")
    venues = data.get("venues")
    if not isinstance(venues, dict):
        fail(f"{name}: missing or malformed 'venues' object")
        return
    if not venues:
        fail(f"{name}: 'venues' is empty -- the app would render nothing")
        return
    for key in venues:
        if not VENUE_KEY.match(key):
            fail(f"{name}: venue key {key!r} is not '<city>|<category>|<index>'")


def check_dishes() -> None:
    data = load_json("dishes.json")
    if data is None:
        return
    check_venue_keys("dishes.json", data)
    if not isinstance(data.get("venues"), dict):
        return

    total = 0
    for key, venue in data["venues"].items():
        dishes = venue.get("dishes")
        if not isinstance(dishes, list):
            fail(f"dishes.json: {key} has no 'dishes' list")
            continue
        for i, dish in enumerate(dishes):
            total += 1
            where = f"dishes.json: {key}[{i}]"
            if not isinstance(dish, dict):
                fail(f"{where} is not an object")
                continue
            if not dish.get("n"):
                fail(f"{where} has an empty name ('n')")
            src = dish.get("src")
            if not isinstance(src, list) or not src:
                fail(f"{where} has no sources ('src')")
                continue
            # n_src records how many independent sources agreed. Nothing in the
            # shell reads it today, so a drift is an editorial-accuracy problem
            # rather than a rendering one -- warn, do not block a deploy.
            if dish.get("n_src") != len(src):
                warn(
                    f"{where}: n_src={dish.get('n_src')} but src has "
                    f"{len(src)} entries"
                )
    notes.append(f"dishes.json: {len(data['venues'])} venues, {total} dishes")


def check_lineups() -> None:
    data = load_json("lineups.json")
    if data is None:
        return
    check_venue_keys("lineups.json", data)
    if not isinstance(data.get("venues"), dict):
        return

    total = 0
    for key, venue in data["venues"].items():
        nights = venue.get("nights")
        if not isinstance(nights, dict):
            fail(f"lineups.json: {key} has no 'nights' object")
            continue
        for date, night in nights.items():
            total += 1
            where = f"lineups.json: {key} {date}"
            if not ISO_DATE.match(date):
                fail(f"{where}: date key is not YYYY-MM-DD")
            if not isinstance(night, dict):
                fail(f"{where} is not an object")
                continue

            # This one is a hard failure, and it is the reason this file
            # exists. The generator has shipped `"line": "Emkay"` instead of
            # `["Emkay"]`; the shell called .map on it, threw, and took the
            # whole venue sheet down. djTonight() now coerces defensively, but
            # the shape is still wrong at source and must not spread.
            line = night.get("line")
            if not isinstance(line, list):
                fail(
                    f"{where}: 'line' is {type(line).__name__}, must be a list "
                    f"of acts -- got {line!r}"
                )
            elif not line and not night.get("hl"):
                # An empty bill is legitimate: the party is announced before the
                # roster is. But then 'hl' has to carry the billing, or the
                # night renders as nothing at all.
                fail(f"{where}: empty 'line' and no 'hl' headline -- renders blank")

            conf = night.get("conf")
            if conf is not None and conf not in CONFIDENCE:
                fail(
                    f"{where}: confidence {conf!r} is not one of "
                    f"{sorted(CONFIDENCE)}"
                )
    notes.append(f"lineups.json: {len(data['venues'])} venues, {total} nights")


def check_pwa() -> None:
    """A manifest pointing at a missing icon breaks install, silently."""
    manifest = load_json("manifest.json")
    if manifest is None:
        return
    for field in ("name", "start_url", "display", "icons"):
        if field not in manifest:
            fail(f"manifest.json: missing '{field}'")

    for icon in manifest.get("icons", []):
        src = icon.get("src")
        if not src:
            fail("manifest.json: an icon entry has no 'src'")
            continue
        if not (ROOT / src).exists():
            fail(f"manifest.json: icon {src!r} does not exist in the repository")

    start = manifest.get("start_url", "").lstrip("./").split("?")[0]
    if start and not (ROOT / start).exists():
        fail(f"manifest.json: start_url {start!r} does not exist")

    version = load_json("version.json")
    if version is not None:
        if not isinstance(version.get("v"), int):
            fail("version.json: 'v' must be an integer build number")
        if not version.get("build"):
            fail("version.json: missing human-readable 'build' stamp")
        else:
            notes.append(f"version.json: build {version.get('v')}")


def check_assets() -> None:
    """Catch shell references to images that were never committed."""
    index = ROOT / "index.html"
    if not index.exists():
        fail("index.html: missing -- there is nothing to serve")
        return

    html = index.read_text(encoding="utf-8", errors="replace")
    referenced = set(re.findall(r"assets/[\w.\-]+\.(?:jpg|jpeg|png|webp)", html))
    missing = sorted(ref for ref in referenced if not (ROOT / ref).exists())
    if missing:
        for ref in missing[:20]:
            fail(f"index.html references {ref}, which is not committed")
        if len(missing) > 20:
            fail(f"...and {len(missing) - 20} more missing assets")
    notes.append(f"index.html: {len(referenced)} asset references, all present"
                 if not missing else
                 f"index.html: {len(referenced)} asset references")

    # The service worker is the one file that can stop the app loading.
    sw = ROOT / "sw.js"
    if not sw.exists():
        fail("sw.js: missing -- offline support would silently disappear")
        return
    sw_text = sw.read_text(encoding="utf-8")
    for sidecar in ("version.json", "lineups.json", "dishes.json"):
        if sidecar not in sw_text:
            fail(
                f"sw.js: {sidecar} is not in the network-first branch -- it would "
                "fall through to cache-first and serve stale data forever"
            )


def main() -> int:
    check_dishes()
    check_lineups()
    check_pwa()
    check_assets()

    for note in notes:
        print(f"  {note}")

    if warnings:
        print(f"\n{len(warnings)} warning(s) -- not blocking:")
        for w in warnings:
            print(f"  - {w}")

    if failures:
        print(f"\nFAIL -- {len(failures)} problem(s):", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print("\nOK -- site is structurally sound and safe to publish.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
