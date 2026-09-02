# Remote CTS-K-N work through managed Chisel

This is the authoritative, credential-free connection procedure for the
CTS-K-N remote Linux server. Never commit or print Chisel authentication,
endpoint and fingerprint values, SSH private keys, exchange credentials,
Redis data, or raw account reports.

## ChatGPT Work procedure

Use only the owner-only managed activation script:

    /workspace/.network-clients/activate-cts.sh

Activation and SSH must run in the same shell/tool process. Work gives each
tool process a process-local network namespace and egress proxy. A listener
that worked in one process is not reusable evidence for a later process. Each
new remote operation must therefore reactivate the client and verify a
harmless SSH banner before executing any other remote command.

The activation script loads the managed endpoint, fingerprint, and auth only
at execution time. It also exports:

- `CTS_REMOTE_PORT` for the pinned localhost forward;
- `CTS_SSH_KEY` for the owner-only private key;
- `CTS_SSH_KNOWN_HOSTS` for the pinned host entry;
- `CTS_SSH_OPTS` with batch mode, identity isolation, strict host-key checking,
  bounded connection time, and keepalive settings.

It fails closed if the SSH key is absent, unreadable, or not mode `0600`.
Do not copy managed values into a command transcript, repository, report,
backup archive, or chat.

Use this shape inside one process:

    set -Eeuo pipefail
    source /workspace/.network-clients/activate-cts.sh
    read -r -a CTS_SSH_ARGS <<< "$CTS_SSH_OPTS"
    timeout 30s ssh "${CTS_SSH_ARGS[@]}" root@127.0.0.1 \
      'printf "CTS_SSH_BANNER_OK\n"'
    # Only after the banner succeeds, run the required bounded remote command
    # through the same CTS_SSH_ARGS array and localhost target.

Never use direct SSH to the remote host, an alternate proxy, or another VPN as
a fallback. If activation or the pinned banner fails, record the non-secret
failure class and stop remote work.

## Why persistent means reactivatable in Work

The managed binaries and owner-only configuration persist under
`/workspace/.network-clients`. The tunnel process itself is intentionally
process-local. “Keep Chisel active” in Work therefore means:

1. retain and protect the managed client files;
2. source the managed activation at the start of every remote tool process;
3. verify the pinned localhost banner before any remote action;
4. keep all subsequent SSH commands in that same process;
5. stop instead of accepting a changed fingerprint or host key.

Do not install a client systemd unit inside ChatGPT Work. A Work process cannot
provide a reusable cross-process network listener, even when a background PID
continues to exist.

## Repository helper for an isolated operator shell

`scripts/connect-remote-chisel.sh` provides the same sequence for a normal
isolated shell when its owner-only environment is supplied explicitly. Use
environment variables or mode-`0600` files; never place values in Git:

    export CTS_CHISEL_AUTH_FILE='/owner-only/path/chisel-auth'
    export CTS_SSH_KEY='/owner-only/path/private-key'
    export CTS_SSH_KNOWN_HOSTS='/owner-only/path/known-hosts'
    scripts/connect-remote-chisel.sh -- \
      'printf "CTS_SSH_BANNER_OK\n"'

This helper does not replace the managed Work activation.

## Current verification record (2026-08-26)

The supported transport was checked from fresh Work tool processes:

- the managed activation passed `bash -n` and remained mode `0700`;
- the managed Chisel client established the pinned localhost forward;
- the SSH private key remained owner-only at mode `0600`;
- strict pinned host-key verification and the harmless SSH banner succeeded;
- the remote `chisel-server.service` reported loaded, active, running, and
  enabled;
- the activation now exports the canonical key and known-hosts paths itself,
  preventing callers from relying on a stale key location;
- no remote service, application, Redis, deployment, or exchange state was
  changed during these checks.

The checked invariant is: managed activation plus pinned localhost SSH in one
process. A missing listener in a later process is expected and is repaired by
fresh managed activation, not by reusing stale PID or proxy data.

## Resolved incident: process-local proxy (2026-08-27)

A raw Chisel client invocation failed with `network is unreachable` even
though the managed endpoint and remote service were healthy. The failure was
local: the manually started client did not use the HTTP proxy assigned to that
specific Work process. The durable project resolution is:

1. source the managed activation at the start of every remote operation;
2. let activation pass that process's `HTTP_PROXY` to `chisel client --proxy`;
3. run the pinned SSH banner and every follow-up SSH command in the same tool
   process;
4. reactivate in each later process instead of reusing a background PID or
   localhost listener.

This matches Chisel's official client contract: `--proxy` accepts an HTTP
CONNECT or SOCKS5 proxy, while reconnects and keepalives belong to that client
process. See the upstream
[Chisel README](https://github.com/jpillora/chisel/blob/master/README.md#usage).

After using the managed sequence, the pinned tunnel connected, strict SSH host
verification passed, the harmless banner returned, and the remote
`chisel-server.service` was confirmed active and enabled. Endpoint, auth,
fingerprint, private key, and host key remain owner-only runtime inputs; the
repository helper intentionally contains no deployment-specific values.

## Failure classification

| Last reliable evidence | Meaning | Safe action |
| --- | --- | --- |
| No local forward | local process proxy, broker, or endpoint registration failed | reactivate once in the same process; if still blocked, record the broker/network error and stop |
| Fingerprint or Chisel auth rejection | managed client and server identity/auth do not agree | stop; repair the owner-only managed configuration without printing values |
| Chisel connects but another process gets connection refused | Work process namespaces differ | run activation, banner, and SSH operation in one process |
| SSH host-key error | the pinned SSH identity differs | stop and investigate server identity; never auto-accept a replacement |
| SSH key rejection | the owner-only key or server authorization differs | stop and verify the managed key path and server authorization |
| Banner succeeds but a bounded remote command times out | transport works; the remote command or service is unhealthy | diagnose only the explicitly authorized service through the same tunnel |

## Recovery record: broker-cancelled activation (2026-08-27)

A later Work session reproduced a different local failure class: the managed
activation was cancelled by the network approval broker before Chisel ran.
The old PID file then referenced a dead process and a later shell correctly
received `connection refused` on the process-local port. This does **not**
indicate a server-side `chisel-server` failure and must not be repaired by
reusing the PID, calling SSH directly, disabling fingerprint checks, or
copying managed credentials into another client.

The durable recovery sequence is:

1. start a fresh bounded tool process;
2. source the managed activation once in that process;
3. require the pinned `CTS_SSH_BANNER_OK` SSH banner in the same process;
4. continue with remote diagnostics/deployment only if the banner succeeds;
5. if the broker cancels activation again, record `broker cancelled before
   execution`, stop remote mutations, and retry only from a later authorized
   process.

Stale PID/listener state is diagnostic only in Work. The activation script is
the sole owner of listener creation, while banner success—not a PID file or an
old Chisel log line—is the authorization and liveness gate for remote work.

## Persistent Linux client service

This section applies only to a normal persistent Linux client, not ChatGPT
Work and not the CTS server itself. Install
`docs/chisel-client.service.example` as
`/etc/systemd/system/chisel-client.service` and store the four managed values
only in `/etc/chisel/client.env` with owner `root` and mode `0600`:

    AUTH=<managed-auth>
    CTS_CHISEL_ENDPOINT=<managed-endpoint>
    CTS_CHISEL_FINGERPRINT=<managed-fingerprint>
    CTS_CHISEL_FORWARD=<managed-forward-spec>

Then verify the unit and the pinned SSH target:

    systemctl daemon-reload
    systemctl enable --now chisel-client.service
    systemctl status --no-pager chisel-client.service

Do not paste the managed values into the unit, command history, logs, or this
document. The standard `AUTH` environment variable is read by Chisel directly,
so the credential is not exposed through the unit's `ExecStart` arguments. If
an older client environment uses `CTS_CHISEL_AUTH`, rename that key to `AUTH`
before installing this hardened unit. Use the same strict known-hosts and
owner-only SSH-key requirements as the Work procedure.

## Safety boundary

Chisel transport authorization does not authorize unrelated server mutation.
Create the required project checkpoint before an authorized deployment or
other material change. Preserve the remote environment, Redis persistence,
systemd configuration, and rollback artifacts. X01/Mainnet and Bybit remain
read-only; only separately authorized X02 VST tests may submit minimum-volume
orders.
