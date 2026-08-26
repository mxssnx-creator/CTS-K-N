# Remote CTS-K-N work through Chisel

This is the authoritative connection procedure for the CTS-K-N remote Linux
server. It is intentionally credential-free: never commit the Chisel auth
value, an SSH private key, exchange credentials, Redis data, or raw account
reports.

## Authoritative managed Work procedure

For ChatGPT Work sessions, use the owner-only managed activation at
`/workspace/.network-clients/activate-cts.sh`. The activation and the SSH
operation must run in the same shell/tool process. A forward that worked in a
previous tool process is not evidence that a later process can reuse it;
re-activate and verify a harmless SSH banner at the execution edge each time.

The managed files under `/workspace/.network-clients` are the source of truth
for the endpoint, fingerprint, authentication material, SSH key, and pinned
known-hosts data. Do not copy those values into commands, source control,
reports, logs, chat, or backup archives. A remote command may run only after
the managed activation and pinned localhost SSH banner both succeed.

The repository helper described below remains useful for isolated operator
shells where its owner-only environment is supplied explicitly. It is not a
replacement for the managed Work activation.

## Why the working command is process-local

Work-mode gives each command process its own dynamically assigned egress proxy
listener. The value in HTTP_PROXY is valid only inside the process that
received it. A copied port from a previous command can be closed or belong to
another namespace. Chisel and SSH must therefore be launched by the same shell
process, using the inherited HTTP_PROXY value directly.

The helper `scripts/connect-remote-chisel.sh` enforces that sequence for an
isolated operator shell:

    export CTS_CHISEL_AUTH='chisel:<persistent-token>'
    export CTS_SSH_KEY='/path/to/private-server-key'
    export CTS_SSH_KNOWN_HOSTS='/path/to/known_hosts'
    scripts/connect-remote-chisel.sh

For a non-interactive remote command:

    scripts/connect-remote-chisel.sh -- \
      'printf "SSH_OK\n"; id -u; hostname; date -Is'

Prefer CTS_CHISEL_AUTH_FILE with a 0600 owner-only file when the auth value
must be reused in a local automation process. The helper reads it but does not
copy it into the repository or a backup archive.

## Fixed server facts

| Item | Value |
| --- | --- |
| Chisel endpoint | http://152.53.114.112:8090 |
| Expected fingerprint | Q0MxL4WHKwM2JbRy6/6fAUee3600R7pPo1CKov8/EPc= |
| Local forward | 127.0.0.1:2222 -> 127.0.0.1:22 |
| Correct SSH target | root@127.0.0.1 -p 2222 |
| Chisel client used | 1.11.8 |

The direct target root@152.53.114.112 -p 2222 bypasses the tunnel and is
wrong. Port 443 is the separate sslh path, not the Chisel forward.

## Current verification record (2026-08-26)

The managed Work activation was rechecked from a fresh tool process:

- the owner-only activation script passed its shell syntax check;
- Chisel 1.11.8 established the pinned localhost forward;
- a harmless SSH banner succeeded through `127.0.0.1:2222`;
- strict SSH host-key verification succeeded;
- the remote `chisel-server.service` was loaded, active, and enabled;
- a later independent tool process required a fresh managed activation, which
  confirms the process-local proxy/namespace behavior documented above.

This verifies both sides of the supported transport without changing the
remote server, application services, Redis, deployments, or exchange state.

## Previous verification record (2026-08-24)

The Work-mode transport path was rechecked with Chisel 1.11.8 and the
process-local `HTTP_PROXY`:

- the HTTP proxy reached the configured Chisel endpoint;
- the server presented the expected fingerprint shown above;
- an obsolete owner-only client auth file was rejected, which confirmed that
  endpoint and fingerprint verification failed closed;
- after that local file was updated to the active persistent server auth, the
  tunnel connected at approximately 180–213 ms;
- strict SSH host-key verification passed and `root@127.0.0.1 -p 2222`
  returned the expected Linux host identity;
- `/opt/cts-kn`, Redis, NGINX, the application, scheduler and Direct-Trade
  services were inventoried through this path; the app answered HTTP 200 on
  its local port 3002.

The working invariant is therefore confirmed: use the current owner-only auth,
start Chisel and SSH in the same Work-mode process, and target
`root@127.0.0.1`. Never paste the auth value into this document, Git history,
service logs, or a command transcript.

Before the 2026-08-24 maintenance integration, the clean remote repository was
`cc46330ed7dbba3bdceb9ef267b53736e7902c68` on branch
`codex-sync-73d17e5`. A verified pre-deploy checkpoint containing Git, source,
the owner-only environment, systemd units and a fresh Redis RDB was written to
`/var/backups/cts-kn/20260824T051626Z-pre-direct-pf-v101`. Credentials and the
Redis image remain on the server and are not copied into source control.

The supplied NetBird web-SSH peer link was also checked on this date and
returned `Site Unavailable`; it is therefore only an optional recovery path,
not a validated replacement for Chisel. Teleport has no active local profile.

## Persistent client service

This section is only for a normal persistent Linux client. Do not install this
systemd unit inside ChatGPT Work: Work egress and network namespaces are
process-local, so the managed activation above remains mandatory there.

For a normal Linux client machine (not the CTS server itself), install the
credential-free template `docs/chisel-client.service.example` as
`/etc/systemd/system/chisel-client.service`. Put only this line in
`/etc/chisel/client.env` and set it to mode 0600:

    CTS_CHISEL_AUTH=chisel:<persistent-token>

Then run:

    systemctl daemon-reload
    systemctl enable --now chisel-client.service
    systemctl status --no-pager chisel-client.service
    ssh -i /path/to/private-key -p 2222 root@127.0.0.1

The service template deliberately contains the plain endpoint rather than a
Markdown link and passes `user:token` as one argument. Do not include the
presentation escapes from chat (`\:` or `\--`) in the environment value.

## Failure classification

| Last reliable output | Meaning | Action |
| --- | --- | --- |
| no fingerprint | process-local proxy or endpoint failure | start Chisel and SSH in the same command process and pass its inherited proxy |
| expected fingerprint, then `Authentication failed` | server auth and client auth differ | repair/confirm the active server auth; do not rotate host keys |
| `Connected (Latency ...)`, then local SSH says connection refused from another Work-mode command | process namespaces differ | run SSH in the same helper process as Chisel |
| `Connected (Latency ...)`, then SSH host-key error | Chisel works but the pinned SSH host key differs | stop and investigate the server identity |
| `Connected (Latency ...)`, then SSH key rejection | Chisel works but the root SSH key/authorization differs | verify the owner-only private key and remote `authorized_keys` |

## Verification and safety

The helper uses strict SSH host-key checking and the supplied
[127.0.0.1]:2222 known-hosts entry. A successful connection should show the
expected fingerprint and a Chisel Connected (Latency ...) line before SSH
starts. If the fingerprint changes, stop and investigate; do not accept a new
host key automatically.

The server-side production environment remains on the server with owner-only
permissions. Server backups are stored under /var/backups/cts-kn/; source
archives exclude .env files, build output, dependencies, logs, and runtime
data.

## Installed local clients

The persistent local client bundle is under /workspace/.network-clients:

- chisel-1.11.8/chisel
- teleport-18.10.0/tsh
- tailscale_1.102.3_amd64/tailscale and tailscaled
- netbird_0.71.4_linux_amd64/netbird
- redis-8.10.1/bin/redis-server

Common executable symlinks are under `/workspace/.network-clients/bin`.
Teleport, Tailscale, and NetBird may remain installed for unrelated recovery
work, but they are not authorized fallbacks for CTS-K-N maintenance. The
supported project route is managed Chisel over the process-local HTTP proxy.
