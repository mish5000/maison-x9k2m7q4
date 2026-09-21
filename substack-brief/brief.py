#!/usr/bin/env python3
"""SemiAnalysis Brief — fetch the newest SemiAnalysis posts from Substack and
write a briefing for each one that a curious 10-year-old could follow.

Runs on a schedule in GitHub Actions (see .github/workflows/substack-brief.yml)
or locally:  python substack-brief/brief.py

Everything it needs comes from environment variables (or a local .env next to
this file — names only are listed in .env.example):

  ANTHROPIC_API_KEY      required — pays for the summaries
  SUBSTACK_COOKIE        preferred login: the value of the `substack.sid`
                         cookie copied from your browser while logged in
  SUBSTACK_EMAIL         alternative login: Substack email + password
  SUBSTACK_PASSWORD      (you must have set a password on Substack first —
                         it is magic-link only by default)
  BRIEF_PASSPHRASE       optional but strongly recommended on a public repo:
                         encrypts data/briefs.json so the paid content is
                         unreadable to anyone without the passphrase
  NTFY_TOPIC             optional: push a phone notification via ntfy.sh
  APP_URL                optional: link the notification opens
  SUMMARY_MODEL          optional, default claude-opus-5
  MAX_NEW_POSTS          optional, default 5 per run (cost guard)
  SUBSTACK_PUBLICATION_URL   default https://newsletter.semianalysis.com
  SUBSTACK_PUBLICATION_SLUG  default semianalysis
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import re
import sys
import time
from html.parser import HTMLParser
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(HERE, "data", "briefs.json")
KEEP_MAX = 40          # how many briefs the app keeps
ARCHIVE_LIMIT = 12     # how many recent posts to look at per run
FULL_RATIO = 0.9       # body must have >= 90% of the declared word count to count as "full"

USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


def log(msg: str) -> None:
    print(f"[brief] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[brief] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


# ---------------------------------------------------------------- .env ------
def load_dotenv() -> None:
    """Tiny .env loader for local runs. Never overrides real env vars."""
    path = os.path.join(HERE, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


# ---------------------------------------------------------- HTML -> text ----
class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "ul", "ol", "table", "tr", "blockquote",
             "figure", "figcaption", "section", "article", "pre", "hr"}
    HEADINGS = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### ", "h5": "##### ", "h6": "###### "}
    SKIP = {"script", "style", "noscript", "svg", "button", "form"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
            return
        if self._skip:
            return
        if tag in self.HEADINGS:
            self.parts.append("\n\n" + self.HEADINGS[tag])
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BLOCK:
            self.parts.append("\n")
        elif tag == "img":
            alt = dict(attrs).get("alt")
            if alt and alt.strip():
                self.parts.append(f"\n[image: {alt.strip()}]\n")
        elif tag in ("td", "th"):
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return
        if tag in self.HEADINGS or tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(body_html: str) -> str:
    p = _TextExtractor()
    p.feed(body_html or "")
    text = "".join(p.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def word_count(text: str) -> int:
    return len(text.split())


# ---------------------------------------------------------- Substack --------
class Substack:
    def __init__(self, pub_url: str, pub_slug: str) -> None:
        import requests  # imported here so --help works without deps

        self.pub_url = pub_url.rstrip("/")
        self.pub_host = urlparse(self.pub_url).netloc
        self.pub_slug = pub_slug
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Referer": self.pub_url + "/",
        })
        self.auth_method = "none"

    # -- login ---------------------------------------------------------------
    def login(self) -> str:
        cookie = env("SUBSTACK_COOKIE")
        email, password = env("SUBSTACK_EMAIL"), env("SUBSTACK_PASSWORD")

        if cookie:
            sid = self._extract_sid(cookie)
            for domain in {self.pub_host, "substack.com", "." + self.pub_host}:
                self.s.cookies.set("substack.sid", sid, domain=domain, path="/")
            self.auth_method = "cookie"
            log("using SUBSTACK_COOKIE")
            return self.auth_method

        if email and password:
            payload = {
                "redirect": "/",
                "for_pub": self.pub_slug,
                "email": email,
                "password": password,
                "captcha_response": None,
            }
            attempts = [f"{self.pub_url}/api/v1/login", "https://substack.com/api/v1/login"]
            for url in attempts:
                try:
                    r = self.s.post(url, json=payload, timeout=30,
                                    headers={"Referer": f"{self.pub_url}/sign-in"})
                except Exception as exc:  # network
                    log(f"login POST {url} failed: {exc}")
                    continue
                snippet = (r.text or "")[:300].replace("\n", " ")
                if r.ok:
                    try:
                        body = r.json()
                    except ValueError:
                        body = {}
                    redirect = body.get("redirect") if isinstance(body, dict) else None
                    if isinstance(redirect, str) and redirect.startswith("http"):
                        # custom-domain publications hand back a URL that sets
                        # the session cookie on their own domain — follow it
                        try:
                            self.s.get(redirect, timeout=30, allow_redirects=True)
                        except Exception as exc:
                            log(f"post-login redirect failed: {exc}")
                    self.auth_method = f"password via {url}"
                    log(f"logged in with email/password via {url}")
                    return self.auth_method
                log(f"login at {url} -> HTTP {r.status_code}: {snippet}")
            die(
                "Substack email/password login failed on both endpoints. Common causes: "
                "no password set on your Substack account (it is magic-link only by default — "
                "set one at substack.com/settings), wrong password, or a captcha challenge. "
                "Most reliable fix: use SUBSTACK_COOKIE instead (see README)."
            )

        log("no Substack credentials set — only free previews will be available")
        return self.auth_method

    @staticmethod
    def _extract_sid(raw: str) -> str:
        raw = raw.strip()
        m = re.search(r"substack\.sid=([^;\s]+)", raw)
        if m:
            return m.group(1)
        return raw

    # -- reads ---------------------------------------------------------------
    def _get_json(self, url: str, tries: int = 3):
        last = None
        for i in range(tries):
            try:
                r = self.s.get(url, timeout=45)
                if r.status_code == 429 or r.status_code >= 500:
                    last = f"HTTP {r.status_code}"
                    time.sleep(2 ** i)
                    continue
                r.raise_for_status()
                return r.json()
            except Exception as exc:  # noqa: BLE001
                last = str(exc)
                time.sleep(2 ** i)
        raise RuntimeError(f"GET {url} failed: {last}")

    def archive(self, limit: int = ARCHIVE_LIMIT) -> list[dict]:
        return self._get_json(f"{self.pub_url}/api/v1/archive?sort=new&limit={limit}")

    def post(self, slug: str) -> dict:
        return self._get_json(f"{self.pub_url}/api/v1/posts/{slug}")


def post_is_full(post: dict, text: str) -> tuple[bool, int, int]:
    declared = int(post.get("wordcount") or 0)
    seen = word_count(text)
    if declared <= 0:
        return True, seen, declared          # nothing to compare against
    return seen >= FULL_RATIO * declared, seen, declared


# ---------------------------------------------------------- Claude ----------
SYSTEM_PROMPT = """You turn SemiAnalysis articles into briefings for a smart, curious 10-year-old.

SemiAnalysis writes deep, technical research about semiconductors, AI chips, data centres, networking, memory, power, and the companies behind them (NVIDIA, TSMC, AMD, Broadcom, hyperscalers, and so on). Your reader is bright and interested but knows none of the jargon.

How to write:
- Plain words, short sentences. If a technical word is unavoidable, explain it the first time with a concrete comparison from everyday life (kitchens, lego, traffic, school, sport).
- Keep the article's actual claims, numbers, names, dates and conclusions. Do not soften, invent, or pad. If the author disagrees with a common view, say so and explain their reasons.
- Preserve the article's structure: walk through it in the order it was written so the reader could follow along with the original.
- Keep every important number exact (with its unit) — a 10-year-old can handle "67 times better" or "2.3 gigawatts" if you say what it means.
- Write as if telling a story to one person. Be warm, never babyish or condescending.
- Never write "Content truncated" or similar — if the text you were given is only a preview, say so briefly in big_idea and brief what is there.
"""

BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One plain-English line saying what the article is really about."},
        "big_idea": {"type": "string", "description": "2-4 sentences: the single most important thing the article says, and the author's main conclusion."},
        "story": {
            "type": "array",
            "items": {"type": "string"},
            "description": "8-14 short paragraphs (2-4 sentences each) walking through the article in order, kid-level, with everyday comparisons. Together these should cover the whole article.",
        },
        "why_it_matters": {"type": "string", "description": "2-4 sentences on why anyone should care — who wins, who loses, what changes."},
        "numbers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "value": {"type": "string"},
                    "meaning": {"type": "string", "description": "What this number means, in plain words."},
                },
                "required": ["label", "value", "meaning"],
                "additionalProperties": False,
            },
            "description": "The 4-10 numbers that matter most, kept exact.",
        },
        "words_to_know": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"word": {"type": "string"}, "meaning": {"type": "string"}},
                "required": ["word", "meaning"],
                "additionalProperties": False,
            },
            "description": "3-8 jargon words from the article with one-sentence kid-friendly meanings.",
        },
        "one_line": {"type": "string", "description": "What you would tell a friend about this article in one sentence."},
    },
    "required": ["headline", "big_idea", "story", "why_it_matters", "numbers", "words_to_know", "one_line"],
    "additionalProperties": False,
}


def summarize(client, model: str, post: dict, text: str, is_full: bool) -> dict:
    import anthropic

    status = "the FULL article" if is_full else "only the free PREVIEW of the article (the paid part was not available)"
    user_content = (
        f"Below is {status} from SemiAnalysis.\n\n"
        f"Title: {post.get('title', '')}\n"
        f"Subtitle: {post.get('subtitle', '') or ''}\n"
        f"Published: {post.get('post_date', '')}\n\n"
        f"<article>\n{text}\n</article>\n\n"
        "Write the briefing."
    )
    common = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
        thinking={"type": "adaptive"},
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": BRIEF_SCHEMA}},
    )

    def run(with_fallbacks: bool):
        kwargs = dict(common)
        if with_fallbacks:
            # Server-side refusal fallback: if the model declines, the API re-runs
            # the same request on a fallback model inside the same call.
            kwargs["betas"] = ["server-side-fallback-2026-07-01"]
            kwargs["fallbacks"] = "default"
        with client.beta.messages.stream(**kwargs) as stream:
            return stream.get_final_message()

    try:
        message = run(with_fallbacks=True)
    except anthropic.BadRequestError as exc:
        # Defensive: if this account/model rejects the fallback parameter,
        # retry once without it rather than failing every run.
        log(f"request with fallbacks rejected ({exc.message}); retrying without")
        message = run(with_fallbacks=False)

    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        raise RuntimeError(f"model refused: {getattr(details, 'explanation', None) or details}")
    if message.stop_reason == "max_tokens":
        raise RuntimeError("model output was cut off (max_tokens)")

    text_out = next((b.text for b in message.content if b.type == "text"), "")
    brief = json.loads(text_out)
    usage = message.usage
    log(f"  tokens in={usage.input_tokens} out={usage.output_tokens} model={message.model}")
    return brief


# ---------------------------------------------------------- crypto ----------
KDF_ITERATIONS = 200_000


def encrypt_payload(plain: dict, passphrase: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, nonce = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=KDF_ITERATIONS).derive(passphrase.encode("utf-8"))
    ct = AESGCM(key).encrypt(nonce, json.dumps(plain, ensure_ascii=False).encode("utf-8"), None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return {
        "version": 1,
        "encrypted": True,
        "kdf": "PBKDF2-SHA256",
        "iterations": KDF_ITERATIONS,
        "salt": b64(salt),
        "nonce": b64(nonce),
        "ciphertext": b64(ct),
        "generated_at": plain.get("generated_at"),
        "count": len(plain.get("briefs", [])),
    }


def decrypt_payload(blob: dict, passphrase: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                     salt=base64.b64decode(blob["salt"]),
                     iterations=int(blob.get("iterations", KDF_ITERATIONS))).derive(passphrase.encode("utf-8"))
    plain = AESGCM(key).decrypt(base64.b64decode(blob["nonce"]), base64.b64decode(blob["ciphertext"]), None)
    return json.loads(plain.decode("utf-8"))


# ---------------------------------------------------------- storage ---------
def empty_store(pub_url: str) -> dict:
    return {"version": 1, "generated_at": None,
            "publication": {"name": "SemiAnalysis", "url": pub_url}, "briefs": []}


def load_store(pub_url: str, passphrase: str) -> dict:
    if not os.path.exists(DATA_PATH):
        return empty_store(pub_url)
    with open(DATA_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    if raw.get("encrypted"):
        if not passphrase:
            die("data/briefs.json is encrypted but BRIEF_PASSPHRASE is not set")
        try:
            return decrypt_payload(raw, passphrase)
        except Exception:
            die("could not decrypt data/briefs.json — wrong BRIEF_PASSPHRASE? "
                "(delete the file to start again)")
    return raw if raw.get("briefs") is not None else empty_store(pub_url)


def save_store(store: dict, passphrase: str) -> None:
    payload = encrypt_payload(store, passphrase) if passphrase else store
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    tmp = DATA_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=None if passphrase else 1)
        fh.write("\n")
    os.replace(tmp, DATA_PATH)


# ---------------------------------------------------------- notify ----------
def notify(title: str, body: str, click_url: str) -> None:
    topic = env("NTFY_TOPIC")
    if not topic:
        return
    import requests

    headers = {"Title": title.encode("utf-8").decode("latin-1", "replace"), "Tags": "newspaper",
               "Priority": "default"}
    if click_url:
        headers["Click"] = click_url
    try:
        r = requests.post(f"https://ntfy.sh/{topic}", data=body.encode("utf-8"), headers=headers, timeout=20)
        log(f"ntfy -> HTTP {r.status_code}")
    except Exception as exc:  # noqa: BLE001
        log(f"ntfy failed: {exc}")


# ---------------------------------------------------------- main ------------
def main() -> int:
    load_dotenv()
    pub_url = env("SUBSTACK_PUBLICATION_URL", "https://newsletter.semianalysis.com")
    pub_slug = env("SUBSTACK_PUBLICATION_SLUG", "semianalysis")
    model = env("SUMMARY_MODEL", "claude-opus-5")
    max_new = int(env("MAX_NEW_POSTS", "5") or 5)
    passphrase = env("BRIEF_PASSPHRASE")
    app_url = env("APP_URL")
    dry_run = "--dry-run" in sys.argv   # fetch only, no Claude, no write

    if not dry_run and not env("ANTHROPIC_API_KEY"):
        die("ANTHROPIC_API_KEY is not set")

    store = load_store(pub_url, passphrase)
    known = {b["id"]: b for b in store["briefs"]}

    sub = Substack(pub_url, pub_slug)
    sub.login()

    posts = [p for p in sub.archive() if p.get("type") in (None, "newsletter", "podcast", "thread", "page")]
    posts.sort(key=lambda p: p.get("post_date") or "", reverse=True)
    log(f"archive: {len(posts)} recent posts; {len(known)} already briefed")

    todo = []
    for p in posts:
        prev = known.get(p["id"])
        if prev is None:
            todo.append(p)
        elif not prev.get("full") and sub.auth_method != "none":
            todo.append(p)   # we only had a preview before; try again for the full text
    todo = todo[:max_new]
    if not todo:
        log("nothing new")
        return 0

    client = None
    if not dry_run:
        import anthropic
        client = anthropic.Anthropic()

    new_titles, saw_full = [], False
    for p in todo:
        slug = p["slug"]
        title = p.get("title") or slug
        log(f"fetching: {title}")
        post = sub.post(slug)
        text = html_to_text(post.get("body_html") or "")
        is_full, seen, declared = post_is_full(post, text)
        saw_full = saw_full or is_full
        log(f"  words: {seen} of {declared} declared -> {'FULL' if is_full else 'PREVIEW ONLY'}")
        if dry_run:
            print(text[:1500] + ("\n..." if len(text) > 1500 else ""))
            continue
        if known.get(p["id"]) and not is_full:
            log("  still only a preview; keeping the existing brief")
            continue
        try:
            brief = summarize(client, model, post, text, is_full)
        except Exception as exc:  # noqa: BLE001
            log(f"  summary failed: {exc}")
            continue
        entry = {
            "id": post["id"],
            "slug": slug,
            "title": post.get("title") or title,
            "subtitle": post.get("subtitle") or "",
            "url": post.get("canonical_url") or f"{pub_url}/p/{slug}",
            "post_date": post.get("post_date"),
            "cover_image": post.get("cover_image"),
            "audience": post.get("audience"),
            "full": is_full,
            "words_seen": seen,
            "words_declared": declared,
            "briefed_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "model": model,
            "brief": brief,
        }
        was_new = p["id"] not in known
        known[post["id"]] = entry
        if was_new:
            new_titles.append(entry)

    if dry_run:
        return 0

    if sub.auth_method != "none" and not saw_full:
        log("WARNING: logged-in fetch still returned previews only. The cookie may have "
            "expired, the password login may not have set the publication cookie, or the "
            "subscription is not active for this account.")

    briefs = sorted(known.values(), key=lambda b: b.get("post_date") or "", reverse=True)[:KEEP_MAX]
    store["briefs"] = briefs
    store["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    store["publication"] = {"name": "SemiAnalysis", "url": pub_url}
    save_store(store, passphrase)
    log(f"wrote {DATA_PATH} ({len(briefs)} briefs, {'encrypted' if passphrase else 'plain'})")

    for e in new_titles:
        # Only the public title/subtitle go to ntfy — the paid summary stays in the app.
        notify(f"New SemiAnalysis brief: {e['title']}", e["subtitle"] or "Tap to read the briefing", app_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
