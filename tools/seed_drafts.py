#!/usr/bin/env python3
"""Seed the pad's draft queue from a CSV or JSON list.

Posts to the pad's API (POST /api/drafts) so drafts land in the SQLite queue the
pad actually reads; that endpoint upserts, so re-running after a fresh audit
appends only new drafts and refreshes changed ones.

  python3 tools/seed_drafts.py drafts.csv --raw-html --url http://127.0.0.1:3001 --token $PAD_TOKEN

The legacy drafts.json path remains for an old pad (see the warning it prints).

Safe by construction:
  * creates data/drafts.json if it does not exist
  * NEVER duplicates an id — rows whose id already exists are skipped
  * preserves every existing draft (re-reads the file, then appends)
  * re-reads immediately before writing and writes atomically (tmp + rename),
    so a concurrent edit from the pad is not clobbered mid-run
  * HTML-escapes the `html` field by default (& -> &amp;, < -> &lt;, > -> &gt;)
    so interpolated lead data cannot break the contenteditable editor

Draft shape (matches the server): {id, company, to, cc, subject, from,
reply_to, text, html, created_at}. `to`/`cc` are comma-separated strings.

Usage:
  python3 tools/seed_drafts.py sample.csv
  python3 tools/seed_drafts.py leads.json --drafts /srv/pad/data/drafts.json
  python3 tools/seed_drafts.py sample.csv --dry-run
  python3 tools/seed_drafts.py posts.csv --raw-html        # html column is markup

CSV columns (header row, all optional except one of company/to/subject):
  id, company, to, cc, subject, from, reply_to, text, html
JSON input: a list of objects with the same keys (or {"data": [...]}, etc).

If a row has no `html` but has `text`, an html body is generated from the
escaped text (blank line = paragraph, single newline = <br>) so the draft opens
correctly in the pad's editor.
"""
import argparse
import csv
import json
import os
import urllib.error
import urllib.request
import datetime
import json
import os
import re
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
KIT_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_DRAFTS = os.path.join(KIT_DIR, "data", "drafts.json")

FIELDS = ["id", "company", "to", "cc", "subject", "from", "reply_to", "text", "html",
          "html_is_markup", "created_at", "in_reply_to"]


def esc(s):
    return (str(s if s is not None else "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))


def slug(value):
    s = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower())
    return s.strip("-")


def text_to_html(text):
    """Plain text -> simple escaped <p>/<br> html for the contenteditable editor."""
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    paras = re.split(r"\n{2,}", raw)
    out = []
    for p in paras:
        if not p.strip():
            continue
        out.append("<p>" + esc(p).replace("\n", "<br>") + "</p>")
    return "".join(out)


def read_existing(path):
    """Re-read the live queue. Missing file -> empty list. Malformed -> abort."""
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read().strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"REFUSING TO WRITE: {path} is not valid JSON ({e}). Fix it first.")
    if not isinstance(data, list):
        sys.exit(f"REFUSING TO WRITE: {path} does not contain a JSON array.")
    return data


def write_atomic(path, drafts):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".drafts-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(drafts, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_rows(path):
    ext = os.path.splitext(path)[1].lower()
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        if ext == ".json":
            data = json.load(fh)
            if isinstance(data, dict):
                for v in data.values():
                    if isinstance(v, list):
                        data = v
                        break
            if not isinstance(data, list):
                sys.exit("JSON input must be a list of objects (or a dict containing one).")
            return [r for r in data if isinstance(r, dict)]
        reader = csv.DictReader(fh)
        return [{(k or "").strip(): v for k, v in row.items() if k} for row in reader]


def as_list_string(value):
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v).strip() for v in value if str(v).strip())
    return str(value).strip()


def build_draft(row, raw_html_flag):
    company = str(row.get("company") or "").strip()
    to = as_list_string(row.get("to"))
    cc = as_list_string(row.get("cc"))
    subject = str(row.get("subject") or "").strip()
    raw_id = str(row.get("id") or "").strip()
    draft_id = raw_id or slug(company or to.split(",")[0] or subject)
    if not draft_id:
        return None, "no id and no company/to/subject to derive one from"

    text = str(row.get("text") or "")
    html_in = row.get("html")
    html_out = ""
    if html_in is not None and str(html_in).strip():
        markup = raw_html_flag or str(row.get("html_is_markup") or "").strip().lower() in ("1", "true", "yes")
        html_out = str(html_in) if markup else esc(html_in)
    elif text.strip():
        html_out = text_to_html(text)

    created = str(row.get("created_at") or "").strip() or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    draft = {
        "id": draft_id,
        "company": company,
        "to": to,
        "cc": cc,
        "subject": subject,
        "from": str(row.get("from") or "").strip(),
        "reply_to": str(row.get("reply_to") or "").strip(),
        "text": text,
        "html": html_out,
        "created_at": created,
    }
    if row.get("in_reply_to"):
        draft["in_reply_to"] = str(row["in_reply_to"]).strip()
    return draft, None


def main():
    ap = argparse.ArgumentParser(description="Append drafts to the pad's data/drafts.json safely.")
    ap.add_argument("input", help="CSV or JSON file of recipients/drafts")
    ap.add_argument("--drafts", default=DEFAULT_DRAFTS, help=f"drafts.json path (default {DEFAULT_DRAFTS})")
    ap.add_argument("--data-dir", default="", help="data dir; overrides the default drafts.json location")
    ap.add_argument("--raw-html", action="store_true", help="treat the html column as markup (do not escape it)")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen, write nothing")
    ap.add_argument("--url", default=os.environ.get("PAD_URL", ""),
                    help="pad base URL (default $PAD_URL). When set with a token, drafts go "
                         "through POST /api/drafts instead of the file")
    ap.add_argument("--token", default=os.environ.get("PAD_TOKEN", ""), help="pad token (default $PAD_TOKEN)")
    ap.add_argument("--file-only", action="store_true",
                    help="force the legacy drafts.json path even when a URL is configured")
    args = ap.parse_args()

    drafts_path = os.path.join(args.data_dir, "drafts.json") if args.data_dir else args.drafts
    if not os.path.exists(args.input):
        sys.exit(f"input file not found: {args.input}")
    rows = load_rows(args.input)
    if not rows:
        sys.exit("no rows found in input")

    api_mode = bool(args.url and args.token and not args.file_only)

    if api_mode:
        built, skipped_api = [], []
        for i, row in enumerate(rows, start=1):
            draft, err = build_draft(row, args.raw_html)
            if draft is None:
                skipped_api.append((i, err))
                continue
            built.append(draft)
        print(f"input            : {args.input} ({len(rows)} row(s))")
        print(f"target           : {args.url.rstrip('/')}/api/drafts (SQLite queue)")
        print(f"to import        : {len(built)}")
        for d in built:
            print(f"   + {d['id']}  ->  {d['to'] or '(no recipient)'}  |  {d['subject'] or '(no subject)'}")
        if skipped_api:
            print(f"skipped          : {len(skipped_api)}")
            for i, why in skipped_api:
                print(f"   - row {i}: {why}")
        if args.dry_run:
            print("dry run - nothing posted")
            return 0
        if not built:
            print("nothing to post")
            return 0
        body = json.dumps({"drafts": built}).encode("utf-8")
        req = urllib.request.Request(
            args.url.rstrip("/") + "/api/drafts", data=body, method="POST",
            headers={"Content-Type": "application/json", "x-pad-token": args.token,
                     "User-Agent": "seed-drafts/2.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.loads(r.read().decode("utf-8", "ignore") or "{}")
        except urllib.error.HTTPError as e:
            sys.exit(f"pad refused the import: HTTP {e.code} {e.read().decode('utf-8', 'ignore')[:200]}")
        except Exception as e:
            sys.exit(f"could not reach the pad at {args.url}: {e}")
        print(f"imported         : {out.get('added', 0)} new, {out.get('updated', 0)} refreshed")
        print(f"queue now        : {out.get('queue_length', '?')} draft(s)")
        return 0

    if args.url and not args.token:
        print("note: --url given without --token, falling back to the drafts.json file")

    existing = read_existing(drafts_path)
    seen = {str(d.get("id")) for d in existing if isinstance(d, dict)}
    appended, skipped = [], []
    for i, row in enumerate(rows, start=1):
        draft, err = build_draft(row, args.raw_html)
        if draft is None:
            skipped.append((i, err))
            continue
        if draft["id"] in seen:
            skipped.append((i, f"id '{draft['id']}' already exists"))
            continue
        seen.add(draft["id"])
        appended.append(draft)

    print(f"input            : {args.input} ({len(rows)} row(s))")
    print(f"drafts file      : {drafts_path}")
    print(f"existing drafts  : {len(existing)}")
    print(f"appended         : {len(appended)}")
    for d in appended:
        print(f"   + {d['id']}  ->  {d['to'] or '(no recipient)'}  |  {d['subject'] or '(no subject)'}")
    print(f"skipped          : {len(skipped)}")
    for i, why in skipped:
        print(f"   - row {i}: {why}")

    if args.dry_run:
        print("dry run — nothing written")
        return 0
    if not appended:
        print("nothing to write")
        return 0

    # Re-read right before the write, then merge + write atomically.
    fresh = read_existing(drafts_path)
    fresh_ids = {str(d.get("id")) for d in fresh if isinstance(d, dict)}
    final = fresh + [d for d in appended if d["id"] not in fresh_ids]
    write_atomic(drafts_path, final)
    print(f"wrote {len(final)} draft(s) to {drafts_path}")
    print("WARNING: this pad reads its queue from SQLite (data/pad.db). A file write only "
          "reaches a pad old enough to still import drafts.json. Set PAD_URL and PAD_TOKEN "
          "(or --url/--token) to post to POST /api/drafts instead.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
