import requests
import pandas as pd
import re
import html

API_URL = "https://marvelsnapzone.com/getinfo/?searchtype=cards&searchcardstype=true"
OUTPUT_CSV = "snap_cards.msz_latest.csv"  # writes a fresh CSV in the local repo clone

# Cards to inspect closely during debugging
SUSPECT_IDS = {
    "nebula",
    "black-knight",
    "martyr",
    "sebastian-shaw",
    "scream",
    "negasonic-teenage-warhead",
    "scarlet-witch",   # known-good comparison
    "abomination",     # likely legitimate blank-text comparison
}

# Cards that are plausibly textless / vanilla enough not to warn on blank rules
KNOWN_TEXTLESS_IDS = {
    "abomination",
    "cyclops",
    "hulk",
    "the-thing",
    "wasp",
    "shocker",
}


def clean_ability(s: str) -> str:
    if not isinstance(s, str):
        return ""
    s = html.unescape(s)
    s = re.sub(r"<[^>]*>", "", s)              # strip HTML tags
    s = s.replace("\r", " ").replace("\n", " ")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def carddefid_to_id(carddefid: str, url: str) -> str:
    """
    Normalize to ids like 'absorbing-man', 'adam-warlock', etc.
    """
    base = None
    if isinstance(carddefid, str) and carddefid:
        base = carddefid
    else:
        if isinstance(url, str) and url:
            slug = url.rstrip("/").split("/")[-1]
            base = "".join(part.capitalize() for part in slug.split("-"))
        else:
            base = ""

    parts = re.findall(r"[A-Z][a-z0-9]*|[0-9]+", base)
    if not parts:
        return base.lower()
    return "-".join(p.lower() for p in parts)


def main():
    print(f"Fetching card data from {API_URL} ...")
    resp = requests.get(API_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    cards_raw = data.get("success", {}).get("cards", [])
    print(f"Got {len(cards_raw)} raw cards.")

    records = []
    blank_rule_warnings = []

    for c in cards_raw:
        url = c.get("url") or ""
        carddefid = c.get("carddefid") or c.get("cardDefId") or ""
        card_id = carddefid_to_id(carddefid, url)

        cost = c.get("cost")
        power = c.get("power")
        ability_raw = c.get("ability") or c.get("flavor") or ""
        rules = clean_ability(ability_raw)

        # Detailed audit for suspect cards
        if card_id in SUSPECT_IDS:
            print("\n" + "=" * 100)
            print(f"CARD ID:      {card_id}")
            print(f"NAME:         {c.get('name')}")
            print(f"CARDDEFID:    {carddefid!r}")
            print(f"URL:          {url!r}")
            print(f"COST:         {cost!r}")
            print(f"POWER:        {power!r}")
            print(f"ABILITY RAW:  {ability_raw!r}")
            print(f"ABILITY CLEAN:{rules!r}")
            print(f"ALL KEYS:     {sorted(c.keys())}")

            # Also print any fields that look text-like or might contain card text
            interesting_fields = []
            for k, v in c.items():
                if not isinstance(v, str):
                    continue
                k_lower = str(k).lower()
                if (
                    "ability" in k_lower
                    or "text" in k_lower
                    or "desc" in k_lower
                    or "effect" in k_lower
                    or "rule" in k_lower
                    or "name" in k_lower
                ):
                    interesting_fields.append((k, v))

            if interesting_fields:
                print("INTERESTING TEXT-LIKE FIELDS:")
                for k, v in interesting_fields:
                    print(f"  - {k}: {v!r}")
            else:
                print("INTERESTING TEXT-LIKE FIELDS: none found")

        # Warn on suspicious blanks
        if not rules and card_id not in KNOWN_TEXTLESS_IDS:
            blank_rule_warnings.append({
                "id": card_id,
                "name": c.get("name"),
                "ability_raw": ability_raw,
                "carddefid": carddefid,
                "url": url,
            })
            print(
                f"[WARN] blank rules for {card_id} | "
                f"name={c.get('name')!r} | raw ability={ability_raw!r}"
            )

        records.append({
            "id": card_id,
            "cost": cost,
            "power": power,
            "rules": rules,
        })

    df = pd.DataFrame.from_records(records, columns=["id", "cost", "power", "rules"])
    df = df.sort_values("id").reset_index(drop=True)

    df.to_csv(OUTPUT_CSV, index=False, encoding="utf-8")
    print(f"\nWrote {OUTPUT_CSV} with {len(df)} cards.")

    # End summary
    blank_df = df[df["rules"].fillna("").astype(str).str.strip() == ""].copy()
    print(f"\nTotal rows with blank rules in CSV: {len(blank_df)}")

    if not blank_df.empty:
        print("First 50 blank-rule IDs in CSV:")
        for card_id in blank_df["id"].head(50).tolist():
            print(f"  - {card_id}")

    if blank_rule_warnings:
        print(f"\nSuspicious blank-rule warnings emitted: {len(blank_rule_warnings)}")
        print("First 50 warning rows:")
        for row in blank_rule_warnings[:50]:
            print(
                f"  - id={row['id']!r}, name={row['name']!r}, "
                f"carddefid={row['carddefid']!r}, raw_ability={row['ability_raw']!r}"
            )
    else:
        print("\nNo suspicious blank-rule warnings emitted.")


if __name__ == "__main__":
    main()