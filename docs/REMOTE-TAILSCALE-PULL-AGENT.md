# Remote Linux deployment via Tailscale and a fail-closed pull agent

This runbook installs CTS-K-N as one production app, one scheduler, one
Direct-Trade worker, and durable local Redis on a Linux server. It uses a
Tailscale tailnet for administration; it does not expose Redis or the CTS
application publicly by default.

The instructions deliberately keep private keys, Tailscale auth keys, and
BingX credentials out of the repository, shell history, service unit files,
and logs.

## 1. Establish regular Tailscale access on the server

Use the server's provider console or an already-authorized management session
for this step. Tailscale must be installed on the server itself and joined to
the same tailnet as the administrator's client.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up --hostname=cts-kn-prod
sudo tailscale set --ssh
sudo tailscale status
sudo tailscale ip -4
```

The `tailscale up` command deliberately opens the normal interactive login
flow. For an unattended server, create a scoped, expiring `tskey-auth-...`
key in the Tailnet admin console and use it only on the server console:

```bash
sudo tailscale up --auth-key='tskey-auth-REPLACE_ON_THE_SERVER' --hostname=cts-kn-prod
sudo tailscale set --ssh
```

Do not paste an auth key, a private SSH key, or the production environment
file into chat, a ticket, Git, or this document. Tailscale SSH authenticates
the tailnet identity and does not require copying an OpenSSH private key to the
server. It leaves ordinary `sshd` and `authorized_keys` untouched for
non-Tailscale connections.

Merge the following least-privilege example into the existing Tailnet policy
(do not replace an existing policy wholesale). Replace the source identity
with the administrator identity or group used in the Tailnet:

```jsonc
{
  "tagOwners": {
    "tag:cts-prod": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["autogroup:admin"],
      "dst": ["tag:cts-prod:22", "tag:cts-prod:3002"]
    }
  ],
  "ssh": [
    {
      "action": "check",
      "src": ["autogroup:admin"],
      "dst": ["tag:cts-prod"],
      "users": ["root"],
      "checkPeriod": "12h"
    }
  ]
}
```

Tag the server `tag:cts-prod` in the Tailnet admin console, then verify from a
client that is already joined to that tailnet:

```bash
tailscale ping <server-tailnet-ip-or-magicdns-name>
tailscale ssh root@<server-tailnet-ip-or-magicdns-name>
```

If the Tailnet policy does not permit Tailscale SSH, use only a normal OpenSSH
public key installed through the provider console. Never copy a private key to
the server; derive and install only its public counterpart.

## 2. Prepare the production environment outside the checkout

Create the external file with owner-only permissions on the server. Enter the
actual values interactively on the server; do not use the placeholder values
below as credentials.

```bash
sudo install -d -m 0750 /etc/cts-kn
sudo install -m 0600 /dev/null /etc/cts-kn/production.env
sudoedit /etc/cts-kn/production.env
```

Minimum X02 Prod-VST configuration:

```dotenv
BINGX_ENVIRONMENT=prod-vst
BINGX_VST_ORIGIN=https://open-api-vst.bingx.com
BINGX_X02_API_KEY=SET_ON_THE_SERVER
BINGX_X02_API_SECRET=SET_ON_THE_SERVER
```

Keep X01 production credentials absent unless intentionally configured. The
application still requires its independent live-order readiness and user
confirmation gates for any real-money venue.

## 3. Bootstrap the server with native durable Redis

Run the installer from a temporary clone so a fresh server and a future
reinstallation use exactly the same entrypoint:

```bash
bootstrap_dir="$(mktemp -d)"
git clone --depth 1 --branch main https://github.com/mxssnx-creator/CTS-K-N.git "$bootstrap_dir"
sudo bash "$bootstrap_dir/scripts/bootstrap-install.sh" \
  --dir /opt/cts-kn \
  --name cts-kn \
  --port 3002 \
  --runtime systemd \
  --service-user cts-kn \
  --env-file /etc/cts-kn/production.env \
  --repository https://github.com/mxssnx-creator/CTS-K-N.git \
  --branch main \
  -- --redis-mode native
```

The installer configures native local Redis with AOF persistence and uses it
as the shared store for the app, scheduler, and Direct-Trade worker. It
calculates conservative CPU and memory limits from the effective host/cgroup
budget and keeps only one retained strategy graph active by default.

Verify the installed services before enabling any live workflow:

```bash
sudo systemctl status cts-kn cts-kn-scheduler cts-kn-direct-trade redis-server --no-pager
sudo redis-cli ping
curl -fsS http://127.0.0.1:3002/api/health
sudo journalctl -u cts-kn -u cts-kn-scheduler -u cts-kn-direct-trade -n 200 --no-pager
```

## 4. Install the pull agent

The pull agent does not `git pull` into a running process. It fetches the
approved branch, rejects dirty or non-fast-forward history, and then invokes
the canonical clean `scripts/update.sh` lifecycle. That lifecycle preserves
the external environment and persistent CTS state, stops all CTS-owned workers
cleanly, rebuilds, runs deployment checks, and restarts the services.

```bash
sudo bash /opt/cts-kn/scripts/install-pull-agent.sh \
  --dir /opt/cts-kn \
  --name cts-kn \
  --port 3002 \
  --service-user cts-kn \
  --env-file /etc/cts-kn/production.env \
  --repository https://github.com/mxssnx-creator/CTS-K-N.git \
  --branch main \
  --interval 15min \
  --on-boot 3min

sudo systemctl start cts-kn-pull-agent.service
sudo systemctl status cts-kn-pull-agent.service --no-pager
sudo systemctl list-timers cts-kn-pull-agent.timer --no-pager
sudo journalctl -u cts-kn-pull-agent.service -n 200 --no-pager
```

To pause automated updates while keeping the installation and production
environment intact:

```bash
sudo systemctl disable --now cts-kn-pull-agent.timer
```

To remove only the pull agent configuration:

```bash
sudo bash /opt/cts-kn/scripts/install-pull-agent.sh --uninstall
```

## Operational limits

- A Tailnet connection is a legitimate private network path, not a way to
  bypass a host, provider, or sandbox network policy. The administrator and
  server must both join the same authorized Tailnet.
- The local development sandbox may be unable to install Tailscale, run a
  daemon, or route to the Tailnet. In that case, complete section 1 on the
  VPS console or another writable, authorized Tailnet node first.
- The update timer is intentionally fail-closed: it will not overwrite local
  tracked changes and it will not follow a rewritten remote branch.
- A successful installer health check demonstrates the CTS application and
  its local dependencies. It cannot guarantee external venue availability,
  DNS, a Tailnet policy, or an exchange API at all future times.

For Tailscale SSH policy and authentication details, see the official
[Tailscale SSH documentation](https://tailscale.com/docs/features/tailscale-ssh)
and [tailnet access-control documentation](https://tailscale.com/docs/features/access-control).
