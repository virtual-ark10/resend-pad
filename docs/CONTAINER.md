# Running the pad in a container

The kit is containerised so it moves between hosts with one command. The image
holds code only; `config.json`, `.env` and `data/` live on the host.

## Files

| File | Baked into image? | Why |
|---|---|---|
| `Dockerfile` | — | `node:22-alpine`, no install step (zero npm deps), runs as `node` |
| `docker-compose.yml` | — | one service, loopback-only port, hardened, healthcheck |
| `.env` | **no** (gitignored) | `RESEND_API_KEY`, `PAD_TOKEN`, `RESEND_WEBHOOK_SECRET` |
| `config.json` | **no** (gitignored) | branding, templates, limits - mounted read-only |
| `data/` | **no** (gitignored) | `drafts.json`, `sent-drafts.jsonl`, `webhooks.jsonl` |

## Run it here

```bash
docker compose up -d --build
docker compose logs -f pad                 # startup banner + request log
curl -s localhost:3001/api/health          # {"ok":true,...}
docker compose exec pad ls -l /app/data    # volume is mounted
```

The pad is on `http://127.0.0.1:3001` (loopback only). The client is served at
`/` with the `PAD_TOKEN` as the login.

## Expose it through a reverse proxy

Nothing changes from the non-container instructions - the container publishes on
the host's loopback, so the shipped helper still applies:

```bash
python3 add_caddy_route.py --path /pad --port 3001
```

That gives `https://<host>/pad/` for the UI and
`https://<host>/pad/api/webhook` for Resend (set `RESEND_WEBHOOK_SECRET` to the
Svix secret from the dashboard, then `docker compose up -d` to reload).

## Move to a new VPS

Two options; both end in the same place.

**1. Copy the folder (works with no repo access, and no build on the new host).**
The image is a tag, the state is three paths:

```bash
# on the old host
docker save pad-kit:latest | gzip > pad-kit-$(date +%F).tar.gz
sha256sum pad-kit-$(date +%F).tar.gz
tar czf pad-host.tgz .env config.json data docker-compose.yml Dockerfile docs/CONTAINER.md

# on the new host (verify the checksum before loading)
scp old-host:~/pad-kit-*.tar.gz old-host:~/pad-host.tgz .
sha256sum -c <<< "<checksum>  pad-kit-<date>.tar.gz"
gunzip -c pad-kit-*.tar.gz | docker load
mkdir -p pad && tar xzf pad-host.tgz -C pad
cd pad && docker compose up -d --no-build     # --no-build: use the loaded image
```

**2. Clone and build (needs repo access on the new host).**

```bash
git clone <this repo> pad-kit && cd pad-kit
cp config.json .env from your backup      # gitignored, so bring them yourself
docker compose up -d --build
```

Either way the draft queue, send log and webhook archive come along in `data/`.

## Verify after any move

```bash
curl -s localhost:3001/api/health
TOKEN=$(grep -E '^PAD_TOKEN=' .env | cut -d= -f2-)
curl -s -H "X-Pad-Token: $TOKEN" localhost:3001/api/drafts | head -c 200   # queue intact
curl -s -H "X-Pad-Token: $TOKEN" "localhost:3001/api/received?limit=3"     # needs read-scope key
```

## Notes

- The container runs read-only with all capabilities dropped; only `/app/data`
  and `/tmp` are writable. If a future version writes elsewhere, add a mount
  rather than relaxing `read_only`.
- `mem_limit: 192m` / `cpus: 0.5` are deliberate: the measured footprint is
  ~18 MiB RSS and ~0% CPU, so the ceiling is generous. Raise it only with a
  reason - the point of the ceiling is that the pad can never be the process
  that starves another service on the host.
- 3001 is the kit's default host port. If it is already taken on your host,
  set `PAD_HOST_PORT` in `.env` (e.g. `PAD_HOST_PORT=3021`) rather than stopping
  whatever holds it, then point the proxy at the new port.
- `data/` is a bind mount on purpose: backup = copy that folder, and the
  queue survives image rebuilds.
- Don't scale this service. It is a single-writer JSON store on one volume; two
  replicas would fight over `drafts.json`.
