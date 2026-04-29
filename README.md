# brotalius dashboard

A self-hosted web dashboard for managing Minecraft servers on a Linux box. Login-protected, role-based, with audit logging and an optional in-browser terminal.

```
┌─────────────────────────────────────────────────────┐
│            dash.brotalius.com (HTTPS)               │
│                       │                             │
│            Cloudflare Tunnel                        │
│                       │                             │
│        ┌──────────────▼──────────────┐              │
│        │   Node.js / Fastify         │              │
│        │   on 127.0.0.1:8080         │              │
│        │                             │              │
│        │   - login (argon2 + cookie) │              │
│        │   - per-server roles        │              │
│        │   - systemctl --user start  │              │
│        │   - rcon-client commands    │              │
│        │   - sandboxed file editor   │              │
│        │   - ttyd proxy (optional)   │              │
│        └──────────────┬──────────────┘              │
│                       │                             │
│        ┌──────────────▼──────────────┐              │
│        │  Minecraft (systemd user    │              │
│        │  services + RCON)           │              │
│        └─────────────────────────────┘              │
└─────────────────────────────────────────────────────┘
```

## features

- **Username/password login** — argon2id hashing, signed cookie sessions, login rate limiting.
- **Per-server roles.** Every user has a list of (server, role) pairs:
  - **starter** can only press Start on that server
  - **operator** can stop, restart, manage whitelist, send console commands, edit files
  - **super-operator** (global flag) can do everything everywhere and manage users
- **In-game commands via RCON.** No need to attach to a console.
- **Sandboxed file editing.** Operators can browse and edit text files inside each server's folder; path traversal is blocked.
- **Audit log.** Every state change (login, start, stop, whitelist, file write, etc.) is appended with timestamp, user, and IP.
- **Optional in-browser shell** (super-only) using `ttyd` proxied through the dashboard's auth.
- **No open ports.** Cloudflare Tunnel reaches the dashboard outbound; the box itself listens only on `127.0.0.1`.

## requirements

- Linux server (instructions assume Debian 12+; should work on Ubuntu and similar with minor tweaks)
- Node.js 20+
- Java 17+ (for the Minecraft servers themselves)
- A Cloudflare account with your domain on it
- Outbound internet (no port forwarding needed)

---

# end-to-end setup

The setup below is what was actually performed to get this running on a fresh Debian 13 box. Follow it in order.

## 1. base system

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git openjdk-21-jre-headless sqlite3 build-essential

# Node 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # should be v20.x
```

## 2. user-level systemd

The dashboard, Cloudflare Tunnel, ttyd, and each Minecraft server all run as systemd **user** services. This keeps everything off root and means a crashed Minecraft server can't take the system down.

Enable lingering so user services keep running after you log out of SSH:

```bash
sudo loginctl enable-linger $USER
```

(If `loginctl enable-linger admi` without sudo gives `Access denied`, that's expected on Debian — use `sudo`.)

## 3. minecraft server folders

```bash
sudo mkdir -p /srv/mcserv
sudo chown -R $USER:$USER /srv/mcserv
mkdir /srv/mcserv/fabric01
cd /srv/mcserv/fabric01

# fabric installer (or use vanilla / paper / etc. — the dashboard doesn't care)
wget https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar -O fabric-installer.jar
java -jar fabric-installer.jar server -mcversion 1.20.4 -downloadMinecraft

# accept the EULA
echo "eula=true" > eula.txt

# start once to generate server.properties (then Ctrl+C)
java -Xmx2G -jar fabric-server-launch.jar nogui
```

Edit `server.properties` and set:

```
enable-rcon=true
rcon.port=25575
rcon.password=<long random password>
white-list=true
```

Save the RCON password — you'll need it in the dashboard's `.env`.

Repeat this section for each Minecraft server you want to manage. Use a unique RCON port per server (`25575`, `25576`, ...) so they don't conflict.

## 4. dashboard

```bash
sudo mkdir -p /srv/dashboard
sudo chown -R $USER:$USER /srv/dashboard
cd /srv/dashboard

# either git clone your fork, or unzip this archive here
# (assuming you've extracted the dashboard folder contents to /srv/dashboard)

npm install
```

`npm install` will compile two native modules (`argon2` and `better-sqlite3`). If it fails with a Python or compiler error, you forgot `build-essential` — install it and rerun.

### configure

```bash
cp .env.example .env

# generate a session secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Edit `.env` and set:
- `SESSION_SECRET` to that random string
- `RCON_PASSWORD_VANILLA` (and one per server) to the password from `server.properties`
- `TERMINAL_ENABLED=true` if you want the in-browser shell (see step 7)

Edit `servers.json` to match your real servers. The `name` is the URL-safe identifier used in permissions; `display_name` is what the UI shows; `folder` is the server's directory; `systemd_unit` is the service name; `password_env` must match a variable name in `.env`.

### create your first super-operator

```bash
node scripts/create-user.js mael --super
```

You'll be prompted for a password (12 character minimum). This is the only way to create the first user — there's a chicken-and-egg problem otherwise.

If you forget the password, just delete the user and recreate:
```bash
sqlite3 data/dashboard.db "DELETE FROM users WHERE username = 'mael';"
node scripts/create-user.js mael --super
```

### run the dashboard as a service

Copy the systemd unit file and enable it:

```bash
mkdir -p ~/.config/systemd/user
cp /srv/dashboard/systemd/dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dashboard
systemctl --user status dashboard
```

It should say `active (running)` and listen on `127.0.0.1:8080`. Don't expose port 8080 — Cloudflare Tunnel reaches it from the same machine.

## 5. minecraft server as a systemd service

Copy the example unit and adjust paths:

```bash
cp /srv/dashboard/systemd/mc-vanilla.service ~/.config/systemd/user/
nano ~/.config/systemd/user/mc-vanilla.service
# edit WorkingDirectory and ExecStart to match your server
systemctl --user daemon-reload
systemctl --user enable mc-vanilla
```

The `name` in `servers.json` and the `mc-<name>.service` filename should match — that's how the dashboard finds the service when you click Start.

## 6. cloudflare tunnel

Install cloudflared:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

Log in and create a tunnel:

```bash
cloudflared tunnel login           # opens a URL — open it in a browser, pick the zone
cloudflared tunnel create brotalius-dash
cloudflared tunnel route dns brotalius-dash dash.brotalius.com
```

Note the tunnel ID printed — you'll put it in the config. Then create the config:

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Paste (replace `<tunnel-id>` with the actual ID):

```yaml
tunnel: <tunnel-id>
credentials-file: /home/admi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: dash.brotalius.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Set up cloudflared as a user service:

```bash
cp /srv/dashboard/systemd/cloudflared.service ~/.config/systemd/user/
# edit ExecStart to: /usr/bin/cloudflared tunnel run brotalius-dash
nano ~/.config/systemd/user/cloudflared.service
systemctl --user daemon-reload
systemctl --user enable --now cloudflared
systemctl --user status cloudflared
```

Visit `https://dash.brotalius.com` — you should see the login page.

## 7. (optional) in-browser terminal

The dashboard can proxy a real bash terminal through `ttyd`, gated by your super-operator session. It lives at `/terminal.html`.

```bash
# install ttyd (not in Debian repos — pull from GitHub)
curl -L https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /tmp/ttyd
sudo mv /tmp/ttyd /usr/local/bin/ttyd
sudo chmod +x /usr/local/bin/ttyd
ttyd --version

# install the systemd unit
cp /srv/dashboard/systemd/ttyd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ttyd
systemctl --user status ttyd
```

In `.env`, set:
```
TERMINAL_ENABLED=true
```

Restart the dashboard:
```bash
systemctl --user restart dashboard
```

Visit `https://dash.brotalius.com/terminal.html` — you should get a real bash shell as the dashboard user, only accessible to super-operators.

If you want to disable the terminal later, set `TERMINAL_ENABLED=false` (or remove the line) and restart the dashboard.

---

# managing the system

## adding more minecraft servers

1. Create the server in a new folder under `/srv/mcserv/<name>/`
2. Set RCON in its `server.properties` with a unique port and password
3. Copy `mc-vanilla.service` to `mc-<name>.service`, edit paths, enable it
4. Add a new entry to `servers.json` matching the name and password env var
5. Add the password to `.env` as `RCON_PASSWORD_<NAME>` (uppercase)
6. `systemctl --user restart dashboard`

## adding users

Once you have at least one super-operator:

1. Log in as super
2. Go to **users** → fill in username and password → **create**
3. Use the per-server dropdowns to set roles

To bootstrap a second super if you only have CLI access:
```bash
node scripts/create-user.js friend --super
```

## audit log

Every state change is recorded. View recent entries from the API:
```
GET /api/audit?limit=200       (super-only)
```

Or directly from SQLite:
```bash
sqlite3 /srv/dashboard/data/dashboard.db "SELECT datetime(ts/1000,'unixepoch'), username, action, target FROM audit_log ORDER BY ts DESC LIMIT 50;"
```

## updating the dashboard

```bash
cd /srv/dashboard
git pull         # if you cloned from git
npm install      # in case dependencies changed
systemctl --user restart dashboard
```

The SQLite database is preserved across restarts.

## backups

What to back up:

- `/srv/dashboard/data/dashboard.db` — users, sessions, audit log
- `/srv/dashboard/.env` — secrets
- `/srv/dashboard/servers.json` — server registry
- Each `/srv/mcserv/<name>/world/` — your worlds
- Each Minecraft server's `server.properties`, `whitelist.json`, `ops.json`, `banned-players.json`

A simple snapshot:
```bash
tar czf /backup/dashboard-$(date +%Y%m%d).tar.gz \
  /srv/dashboard/data /srv/dashboard/.env /srv/dashboard/servers.json
tar czf /backup/mc-$(date +%Y%m%d).tar.gz /srv/mcserv
```

Set this up as a cron or systemd timer.

---

# troubleshooting

## "ECONNREFUSED 127.0.0.1:7681" when opening /terminal.html

ttyd isn't running. Check:
```bash
systemctl --user status ttyd
```
Common cause: the unit file points at `/usr/bin/ttyd` but ttyd lives at `/usr/local/bin/ttyd`. Fix the unit and reload.

## "Body cannot be empty when content-type is set to 'application/json'"

Old browser cache of `app.js`. Hard refresh (`Ctrl+Shift+R`).

## "FastifyError: fastify-plugin: @fastify/static - expected '4.x' fastify version"

The lockfile pinned an old plugin version. Run:
```bash
npm install @fastify/static@latest @fastify/cookie@latest @fastify/http-proxy@latest
```

## "Error: unable to determine transport target for 'pino-pretty'"

You upgraded from an older version. The current `server.js` doesn't use pino-pretty. If you've customized your own `server.js`, remove any `transport: { target: 'pino-pretty' }` line.

## Dashboard can press Start but the unit fails

Check `journalctl --user -u mc-<name> --no-pager -n 50`. Common causes:
- `code=exited, status=203/EXEC` → wrong path in `ExecStart`
- Java not found → `apt install openjdk-21-jre-headless`
- Port in use → another server on the same port
- Missing `eula.txt` → `echo "eula=true" > eula.txt` in the server folder

## Logs

```bash
journalctl --user -u dashboard    --no-pager -n 50
journalctl --user -u cloudflared  --no-pager -n 50
journalctl --user -u ttyd         --no-pager -n 50
journalctl --user -u mc-vanilla   --no-pager -n 50
```

## Forgot super-operator password

```bash
cd /srv/dashboard
sqlite3 data/dashboard.db "DELETE FROM users WHERE username = 'YOUR_USERNAME';"
node scripts/create-user.js YOUR_USERNAME --super
```

---

# letting players join from outside your network

The dashboard handles management — separate problem from how players actually connect to Minecraft.

For Minecraft TCP traffic without opening a port at home, the easiest option is **playit.gg**:

1. Sign up, install their agent on the same box
2. Map your local `127.0.0.1:25565` to a playit hostname
3. Add an SRV record in Cloudflare:
   - Type: `SRV`
   - Name: `mcv` (or whatever subdomain you want)
   - Service: `_minecraft`, Protocol: `TCP`
   - Port: the port playit assigned
   - Target: your playit hostname
   - **Proxy: DNS only** (grey cloud — Cloudflare's HTTP proxy can't carry Minecraft traffic)

Players type `mcv.brotalius.com` and Minecraft follows the SRV record automatically.

For private friends-only setups, [Tailscale](https://tailscale.com) is a more secure alternative — no public IP at all, only people on your tailnet can connect.

---

# security notes

- The dashboard binds to `127.0.0.1`. Don't change `HOST` to `0.0.0.0`.
- Every state-changing endpoint re-checks the role server-side — don't trust frontend hiding alone.
- File paths from operators are sandboxed against the server's folder root. This is the most security-critical code in `servers.js`.
- `is_super` should be granted to people you fully trust — supers can change other users' passwords and access every server.
- The `/terminal` proxy gives bash access. Only super-operators reach it. Treat super-operator like root SSH.
- RCON passwords in `.env` should be long and unique per server.
- Run the dashboard as a non-root user (`admi`, `dashboard`, anything but root).
- Keep your Cloudflare Tunnel credentials safe — they're effectively a router for your subdomain.

---

# what's NOT in here (yet)

Things you might want to add later:

- **2FA** — TOTP via `otplib` is straightforward to add
- **Live log streaming** — `journalctl -fu mc-vanilla` over Server-Sent Events
- **File upload** — for replacing jars / uploading mods (multipart endpoint)
- **Email password reset** — currently you reset via CLI or another super-op
- **Backup automation** — cron + restic/borg outside the dashboard

The architecture supports adding any of these without major rework.

---

# license

Whatever you want. This was built for personal use — adapt freely.
