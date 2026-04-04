import requests
import pandas as pd
import re
import html

API_URL = "https://marvelsnapzone.com/getinfo/?searchtype=cards&searchcardstype=true"
OUTPUT_CSV = "snap_cards.msz_latest.csv"  # <-- NEW FILE, does NOT touch your original


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
    for c in cards_raw:
        url = c.get("url") or ""
        carddefid = c.get("carddefid") or c.get("cardDefId") or ""
        card_id = carddefid_to_id(carddefid, url)

        cost = c.get("cost")
        power = c.get("power")
        ability_raw = c.get("ability") or ""

        rules = clean_ability(ability_raw)

        records.append({
            "id": card_id,
            "cost": cost,
            "power": power,
            "rules": rules,
        })

    df = pd.DataFrame.from_records(records, columns=["id", "cost", "power", "rules"])
    df = df.sort_values("id").reset_index(drop=True)

    df.to_csv(OUTPUT_CSV, index=False, encoding="utf-8")
    print(f"Wrote {OUTPUT_CSV} with {len(df)} cards.")


if __name__ == "__main__":
    main()
