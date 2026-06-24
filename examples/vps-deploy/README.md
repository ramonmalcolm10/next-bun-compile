# Example: deploy to a VPS with zero runtime dependencies

Build the Next.js app into a single Linux binary in GitHub Actions, ship
it to a VPS over SSH, run it under systemd. The VPS needs nothing
installed but ssh, systemd, and a working glibc — no node, no bun, no
node_modules. No package manager, no Docker.

## Why

| | Vercel | bun next start on VPS | `next-bun-compile` on VPS |
|---|---|---|---|
| Runtime deps on VPS | n/a | bun + node_modules + nm tree | nothing — just the binary |
| Deploy artifact | git push | rsync dir tree (~150MB) | scp one file (~30MB) |
| Zero-downtime swap | automatic | restart bun process | atomic mv + systemctl restart |
| Lock-in | platform | none | none |

## What's here

```
vps-deploy/
├── app/                         # the Next.js app (minimal)
│   ├── api/healthz/route.ts     # readiness endpoint for the smoke test
│   ├── layout.tsx
│   └── page.tsx
├── next.config.ts               # output: "standalone"
├── package.json                 # build:linux-x64 / build:linux-arm64 scripts
├── .github/workflows/
│   └── deploy.yml               # the build + ship workflow
├── systemd/
│   └── next-app.service         # the unit file (one-time install on VPS)
└── README.md                    # this file
```

## VPS one-time setup

Pick any VPS that runs systemd and ships glibc — Ubuntu, Debian, Rocky,
anything modern. The smallest tier ($4–6/mo) is fine for most apps.

1. **Create a deploy user.** SSH in as root:

   ```bash
   sudo useradd -r -m -s /bin/bash -d /srv/next-app deploy
   sudo mkdir -p /srv/next-app
   sudo chown -R deploy:deploy /srv/next-app
   ```

2. **Authorize the GitHub Actions SSH key.** Generate a new key on
   your laptop (don't reuse a personal one):

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/next-app-deploy -N ""
   cat ~/.ssh/next-app-deploy.pub
   ```

   On the VPS, add the public key to `deploy`'s authorized_keys:

   ```bash
   sudo -u deploy mkdir -p /srv/next-app/.ssh
   sudo -u deploy bash -c 'echo "PASTE-PUBLIC-KEY-HERE" >> /srv/next-app/.ssh/authorized_keys'
   sudo chmod 700 /srv/next-app/.ssh
   sudo chmod 600 /srv/next-app/.ssh/authorized_keys
   ```

3. **Grant systemd restart privilege to the deploy user** via a
   minimal sudoers rule (no general sudo):

   ```bash
   sudo visudo -f /etc/sudoers.d/deploy-next-app
   ```

   Paste:

   ```
   deploy ALL=(root) NOPASSWD: /bin/systemctl restart next-app, /bin/systemctl status next-app
   ```

4. **Install the systemd unit:**

   ```bash
   sudo cp systemd/next-app.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable next-app
   # Don't start yet — there's no binary in /srv/next-app/server.
   # The first GitHub Actions run will deploy + restart.
   ```

5. **(Optional but recommended) Put caddy in front for TLS:**

   ```bash
   sudo apt install caddy
   ```

   `/etc/caddy/Caddyfile`:

   ```
   example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

   ```bash
   sudo systemctl reload caddy
   ```

   Caddy handles HTTPS certs automatically via Let's Encrypt.

## GitHub repo setup

In repo Settings → Secrets and variables → Actions, add:

**Secrets:**

| Name              | Value                                                    |
|-------------------|----------------------------------------------------------|
| `VPS_HOST`        | `example.com` or VPS IP                                  |
| `VPS_USER`        | `deploy`                                                 |
| `VPS_SSH_KEY`     | contents of `~/.ssh/next-app-deploy` (the private key)   |
| `VPS_KNOWN_HOSTS` | output of `ssh-keyscan example.com` — pin the host key   |

**Variables:**

| Name           | Value                |
|----------------|----------------------|
| `APP_DIR`      | `/srv/next-app`      |
| `SERVICE_NAME` | `next-app`           |

## Deploy

Push to `main`. The workflow:

1. Checks out + installs deps + builds the Linux binary with
   `bun --bun run build:linux-x64`.
2. `scp`s the binary to `$APP_DIR/server.new` on the VPS.
3. Over SSH: atomically `mv server.new server`, `rm -rf .next public`,
   `sudo systemctl restart next-app`.
4. Polls `https://$VPS_HOST/api/healthz` for up to 30s — fails the
   workflow if it doesn't come back 200.

### Why the `rm -rf .next public`?

`extractAssets` is idempotent and skips files that already exist on
disk. Without the wipe, files from the previous deploy that don't
exist in the new binary would linger. Cheap insurance for a clean
filesystem state.

### Why a separate `server.new` then `mv`?

`mv` within the same filesystem is atomic. Even if the binary is
mid-restart, readers either see the old binary or the new one —
never a partially-written file. `scp` writing directly to `server`
would briefly leave the binary truncated.

## Variants

- **ARM VPS (Hetzner, Oracle, AWS Graviton):** swap
  `build:linux-x64` for `build:linux-arm64` in the workflow.
- **Native deps (sharp, bcrypt, etc.):** the binary loads them just
  fine on any glibc-based VPS. For sharp's text rendering features
  (watermarks), the VPS additionally needs fontconfig + a font face:
  `sudo apt install fontconfig fonts-dejavu-core`.
- **Multiple apps on one VPS:** each gets its own user, its own
  `WorkingDirectory`, and its own systemd unit. Caddy in front
  handles host-based routing.
- **No reverse proxy:** set `HOSTNAME=0.0.0.0` and
  `Environment=PORT=80` in the unit, plus `AmbientCapabilities=CAP_NET_BIND_SERVICE`
  to bind a privileged port as non-root.

## Cost reference

A single binary deployment runs comfortably on a $4–6/mo VPS for
typical Next.js apps. Add caddy in front for free TLS. No platform
fees, no per-invocation costs, no surprise bills.
