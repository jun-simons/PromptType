"""Build src/data/words/english.json: a clean, frequency-ordered English word list.

Sources
  - Frequency order: wordfreq (https://github.com/rspeer/wordfreq), which blends
    subtitles, books, Wikipedia, news, Reddit and more. Data CC BY-SA 4.0.
  - Dictionary filter: 12dicts "2of12inf" by Alan Beale (http://wordlist.aspell.net/12dicts/),
    common words with inflections, no proper nouns or abbreviations. Public domain / AGID terms.
  - Profanity filter: LDNOOBW "en" list
    (https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words). CC BY 4.0.

A word is kept when it is lowercase a-z, appears in 2of12inf, is not on the
profanity list, and is not a single letter (except "a"). Order is wordfreq rank,
so the first 200 / 1k / 5k entries are the standard "top N" typing lists.

Usage (offline step, output is committed):
  python3 -m venv .venv && .venv/bin/pip install wordfreq
  .venv/bin/python scripts/build-words.py [--max 30000]
"""

import argparse
import io
import json
import pathlib
import urllib.request
import zipfile

from wordfreq import top_n_list

DICT_ZIP = "https://downloads.sourceforge.net/project/wordlist/12Dicts/6.0/12dicts-6.0.zip"
DICT_MEMBER = "American/2of12inf.txt"
BAD_WORDS = "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en"

# Extra words to drop: slurs/insults the list misses, interjections and fillers that
# rank high in subtitles but make poor typing practice.
EXTRA_BLOCK = set(
    """
    nigger nigga faggot fag retard retarded spic chink kike dyke tranny whore slut bitch bastard
    dick cock tits boob boobs sexy porn
    um uh hmm huh oh ah eh ha yeah yep nope okay ok gonna wanna
    """.split()
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "words" / "english.json"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "word-list-builder"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=30000, help="max words to keep")
    args = ap.parse_args()

    with zipfile.ZipFile(io.BytesIO(fetch(DICT_ZIP))) as z:
        raw = z.read(DICT_MEMBER).decode("latin-1")
    # 2of12inf marks some entries with % or ! — strip the markers, keep the word
    dictionary = {w.strip().rstrip("%!").lower() for w in raw.splitlines() if w.strip()}

    bad = {w.strip().lower() for w in fetch(BAD_WORDS).decode().splitlines() if w.strip() and " " not in w}
    bad |= EXTRA_BLOCK

    words: list[str] = []
    seen: set[str] = set()
    for w in top_n_list("en", 200_000):
        if len(words) >= args.max:
            break
        if w in seen or not w.isascii() or not w.isalpha() or not w.islower():
            continue
        if len(w) == 1 and w != "a":
            continue
        if w not in dictionary or w in bad:
            continue
        seen.add(w)
        words.append(w)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "name": "english",
        "source": "frequency order from wordfreq (CC BY-SA 4.0), filtered by 12dicts 2of12inf (Alan Beale) "
        "and the LDNOOBW profanity list; built by scripts/build-words.py",
        "words": words,
    }
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"wrote {len(words)} words to {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
