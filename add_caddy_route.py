#!/usr/bin/env python3
"""Add a reverse-proxy route for the pad to Caddy via its local admin API.

Usage:
    python3 add_caddy_route.py --path /pad --port 3001
    python3 add_caddy_route.py --path /email --port 3100 --admin http://127.0.0.1:2019
    python3 add_caddy_route.py --path /pad --port 3001 --no-strip

Everything is parameterised: route path and upstream port are arguments, so the
same helper works for any brand, any path and any port. No sudo required — the
Caddy admin API listens on localhost by default.

Routes added (immediately before the catch-all, if one exists):
    {path}    -> 301 redirect to {path}/
    {path}/*  -> rewrite (strip {path}) + reverse_proxy 127.0.0.1:{port}

Idempotent: GET /config/ -> insert if missing -> POST /load (full replace).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_ADMIN = os.environ.get("CADDY_ADMIN", "http://127.0.0.1:2019")
DEFAULT_PORT = os.environ.get("PORT", "3001")


def request(admin, method, path, body=None, ctype=None):
    headers = {"Content-Type": ctype} if ctype else {}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(admin + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        print(f"HTTP {e.code}: {raw[:500]}")
        raise


def find_route_list(cfg, server_name):
    """Return (routes_list, located_by) for the server we should edit."""
    servers = cfg.get("apps", {}).get("http", {}).get("servers", {})
    if not servers:
        raise SystemExit("no apps.http.servers in the Caddy config — is Caddy using the admin API?")
    if server_name and server_name in servers:
        srv = servers[server_name]
    else:
        srv = next(iter(servers.values()))
    # Common Caddyfile->JSON shape: a single subroute handler holds the site routes.
    for r in srv.get("routes", []):
        for h in r.get("handle", []) or []:
            if h.get("handler") == "subroute" and isinstance(h.get("routes"), list):
                return h["routes"], "subroute"
    return srv.get("routes", []), "server"


def main():
    ap = argparse.ArgumentParser(description="Add a pad route to Caddy (idempotent, no sudo)")
    ap.add_argument("--path", required=True, help="public route prefix, e.g. /pad")
    ap.add_argument("--port", default=DEFAULT_PORT, help=f"local upstream port (default {DEFAULT_PORT})")
    ap.add_argument("--admin", default=DEFAULT_ADMIN, help=f"Caddy admin API (default {DEFAULT_ADMIN})")
    ap.add_argument("--host", default="127.0.0.1", help="upstream host (default 127.0.0.1)")
    ap.add_argument("--server", default="", help="Caddy server name (default: first available)")
    ap.add_argument("--no-strip", action="store_true", help="do NOT strip the path prefix before proxying")
    args = ap.parse_args()

    route = "/" + args.path.strip("/")
    tree = route + "/*"
    upstream = f"{args.host}:{args.port}"

    status, cfg = request(args.admin, "GET", "/config/")
    print(f"GET /config/ -> {status}")

    routes, located = find_route_list(cfg, args.server)
    print(f"editing routes from {located} ({len(routes)} existing)")
    for i, r in enumerate(routes):
        paths = (r.get("match") or [{}])[0].get("path", [])
        print(f"  existing[{i}] match={paths}")

    if any((r.get("match") or [{}])[0].get("path") == [tree] for r in routes):
        print(f"route {tree} already present -> nothing to do")
        return 0

    redirect_route = {
        "handle": [{
            "handler": "static_response",
            "status_code": 301,
            "headers": {"Location": [route + "/"]},
        }],
        "match": [{"path": [route]}],
    }
    proxy_handlers = []
    if not args.no_strip:
        proxy_handlers.append({"handler": "rewrite", "strip_path_prefix": route})
    proxy_handlers.append({"handler": "reverse_proxy", "upstreams": [{"dial": upstream}]})
    proxy_route = {"handle": proxy_handlers, "match": [{"path": [tree]}]}

    catchall_idx = None
    for i, r in enumerate(routes):
        paths = (r.get("match") or [{}])[0].get("path", [])
        if not paths:
            catchall_idx = i
            break
    insert_at = catchall_idx if catchall_idx is not None else len(routes)
    routes.insert(insert_at, proxy_route)
    routes.insert(insert_at, redirect_route)
    print(f"inserted {route} + {tree} -> {upstream} at index {insert_at}")

    status, _ = request(args.admin, "POST", "/load", cfg, ctype="application/json")
    print(f"POST /load -> {status}")
    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
