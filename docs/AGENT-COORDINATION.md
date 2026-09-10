# Working on this repo with more than one agent

More than one automated agent (plus the maintainer) pushes to this repository.
Everything so far has been linear on `main`, and nothing has been lost - but
"git reports no conflict" is not the same as "nothing collided". Read this before
your first push.

## What actually happens when two agents commit

- Each agent works in its **own clone**, so file edits never touch each other
  until a push.
- `main` only accepts **fast-forwards**: whoever pushes second is rejected and
  has to integrate first (`git fetch && git rebase origin/main`). That is the
  whole safety net. There are no merges and no force-pushes.
- Textual conflicts only appear when both sides edited **the same lines of the
  same file**. Everything else merges silently - including changes that undo
  each other.

Three real collisions from one day of parallel work, none of which git flagged:

1. **A silently reverted line.** Re-applying a change set onto the other agent's
   commit restored their `Dockerfile` COPY line and dropped mine, so the image
   shipped without `db.cjs`. Git was quiet; both containers crash-looped.
2. **A shared file outside the repo.** A deploy from another project on the same
   host rewrote the reverse-proxy config and dropped this project's site block,
   taking the site offline until it was restored from a snippet.
3. **The same feature in two checkouts.** One checkout's `server.cjs` required
   `db.cjs` that was never copied into that directory. It ran from memory and
   would have failed on its next restart.

## Rules

1. **Never force-push `main`.** If a push is rejected, rebase and push again.
2. **Fetch and rebase immediately before every push.** A clean tree means a
   clone that is behind can fast-forward; a dirty tree cannot, and that is where
   textual conflicts get manufactured.
3. **Branch + PR for shared files.** These are shared: `server.cjs`,
   `index.html`, `config.example.json`, `Dockerfile`, `docker-compose.yml`,
   `README.md`, `AGENT.md`, anything under `docs/`. Open a PR, describe the
   blast radius, and let the other side merge. Direct-to-main is fine for files
   with a single owner.
4. **One owner per area.** Keep the split at the seam that already exists:
   - the store and the engine: `db.cjs`, `hooks.cjs`, `leads/`, `tools/install-crm.sh`
   - the pad surface: `server.cjs`, `index.html`, `config.example.json`, `Dockerfile`
   Cross into the other area deliberately, in a PR, not as a drive-by edit.
5. **Read your own diff before you push.**
   ```
   git fetch origin
   git log --oneline origin/main..HEAD      # what you are adding
   git diff origin/main --stat              # every file you touched
   git rebase origin/main                   # integrate first
   bash tools/smoke.sh                      # then prove it still runs
   ```
   If the rebase changed a file you did not mean to change, stop and look. That
   is how collision 1 above should have been caught.
6. **Do not deploy into another project's directory.** Separate deploy paths,
   separate data directories, separate service names. Never `rsync --delete`
   into a tree you do not own.
7. **Keep reverse-proxy config per project.** On a host that runs several
   projects, one project's deploy can rewrite the shared config file. Own a
   snippet (or a directory of them) and keep the import line self-healing, so a
   rewrite by someone else cannot take your site down.

## Escape hatch

If you are unsure whether your change is safe to push:

- `bash tools/smoke.sh` - starts both services on throwaway ports with a
  temporary data directory and exercises the loop (health, pipeline, events,
  redraft, reply delete). It catches build/ship mistakes, not just syntax.
- Push to a branch and open a PR with the smoke output in the description. A
  branch costs nothing; a broken `main` costs the other agent a debugging hour.

## When to change the arrangement

If two agents keep colliding on `server.cjs` / `index.html`, stop sharing the
file: split the pad surface and the engine into separate repositories (they are
already separate processes with a narrow HTTP seam), or serialise with an
explicit claim in an issue before starting. Do not solve it with force-pushes or
by ignoring the other agent's commits.
