# CTS-K-N Chisel Remote Access — Chat Handoff Info

**Status:** authoritative procedure for CTS-K-N remote work
**Last verified:** 2026-09-03 UTC
**Remote host:** `152.53.114.112`
**Chisel endpoint:** `http://152.53.114.112:8090`
**Forward:** local `127.0.0.1:2222` → remote `127.0.0.1:22`

This file is the short continuity record for future chats. The full operational
background and persistent-Linux variant remain in
[`REMOTE-CHISEL-WORKMODE.md`](./REMOTE-CHISEL-WORKMODE.md).

## Binding Work-Mode procedure

ChatGPT Work uses a process-local network namespace. A Chisel listener or proxy
from another command process cannot be reused. Every remote operation must
therefore start a new bounded shell and run activation, the SSH banner, and all
follow-up commands in that same shell:

```bash
set -Eeuo pipefail
source /workspace/.network-clients/activate-cts.sh
read -r -a CTS_SSH_ARGS <<< "$CTS_SSH_OPTS"
timeout 30s ssh "${CTS_SSH_ARGS[@]}" root@127.0.0.1 \
  'printf "CTS_SSH_BANNER_OK\\n"'
# Only after the banner succeeds, use the same CTS_SSH_ARGS array for work.
```

The managed activation supplies the process-local proxy, Chisel endpoint,
pinned fingerprint, owner-only SSH key, pinned known-hosts file, and strict SSH
options. It exports `CTS_REMOTE_PORT`, `CTS_SSH_KEY`, `CTS_SSH_KNOWN_HOSTS`, and
`CTS_SSH_OPTS`. Do not copy those runtime values into Git, reports, backups,
chat messages, or command output.

## Required transport invariants

1. Chisel must use the proxy assigned to the **same** Work process. In managed
   Work this is handled by `activate-cts.sh`; do not start a raw client without
   the process-local proxy.
2. The local SSH target is always `root@127.0.0.1` through port `2222`; never
   use direct SSH to `152.53.114.112` as a fallback.
3. The harmless `CTS_SSH_BANNER_OK` result is the liveness and authorization
   gate. A PID file, old listener, or old Chisel log is not proof of access.
4. Fingerprint verification and strict SSH host-key verification must remain
   enabled. Never accept a replacement host key automatically.
5. If activation is cancelled or the banner fails, stop remote mutations,
   record only the non-secret failure class, and retry from a fresh bounded
   process when allowed.

## Normal isolated-shell helper

For a normal host (not ChatGPT Work),
`scripts/connect-remote-chisel.sh` implements the same local-forward sequence.
Supply secrets only through owner-only runtime environment/files:

```bash
export CTS_CHISEL_AUTH_FILE=/owner-only/path/chisel-auth
export CTS_SSH_KEY=/owner-only/path/private-key
export CTS_SSH_KNOWN_HOSTS=/owner-only/path/known-hosts
scripts/connect-remote-chisel.sh -- 'printf "CTS_SSH_BANNER_OK\\n"'
```

The helper defaults to local port `2222`, remote SSH port `22`, keepalive
`25s`, and the configured `HTTP_PROXY`/`http_proxy`. On a directly reachable
normal host, `--proxy` may be omitted; in managed Work the process-local proxy
is mandatory.

## Persistent Linux client (not ChatGPT Work)

For a genuine persistent Linux client, install
`docs/chisel-client.service.example` as
`/etc/systemd/system/chisel-client.service`. Store endpoint, fingerprint, auth,
and forward only in `/etc/chisel/client.env`, owned by root with mode `0600`.
Then run:

```bash
systemctl daemon-reload
systemctl enable --now chisel-client.service
systemctl status --no-pager chisel-client.service
```

This systemd listener is not reusable across ChatGPT Work processes. Work must
always use the managed activation script.

## Failure classification and recovery

| Evidence | Classification | Action |
|---|---|---|
| No local `2222` listener | process-local proxy/broker/endpoint activation failure | Fresh activation in the same process; stop if it fails again |
| Chisel auth or fingerprint rejection | managed client/server identity mismatch | Stop and repair owner-only runtime configuration; never disable pinning |
| Chisel connects, later process gets refused | Work namespaces differ | Reactivate in the new process and rerun the banner |
| SSH host-key error | pinned server identity changed | Stop and investigate; never auto-accept |
| SSH key rejection | wrong/missing owner-only identity or server authorization | Verify managed key path and server authorization |
| Banner succeeds, remote command times out | transport works; remote service/command issue | Diagnose only the authorized bounded service command |
| Broker cancelled before Chisel runs | local approval/activation cancellation | Do not reuse stale PID/listener; retry later in a fresh process |

## Verification record

The supported route was verified from a fresh Work process on 2026-09-03 UTC:

- `CTS_SSH_BANNER_OK` returned successfully.
- Remote `chisel-server.service` reported `active` and `enabled`.
- No endpoint, auth, fingerprint, private key, or host-key material was
  printed or stored in this repository.

## Security and scope

Chisel only provides transport. It does not authorize unrelated server changes.
Before deployments, restarts, database repairs, exchange actions, or other
material mutations, create the project checkpoint required by the active task
and operate only on the explicitly requested target. Preserve existing runtime,
Redis persistence, and rollback artifacts.

## Future-chat handoff

At the beginning of a new CTS-K-N chat:

1. Read this file and `docs/REMOTE-CHISEL-WORKMODE.md`.
2. Use `/workspace/.network-clients/activate-cts.sh` in every remote tool
   process.
3. Require the pinned SSH banner before any remote command.
4. Keep activation, banner, diagnostics, and mutations in one process.
5. Never request, print, commit, or recreate the managed secrets.
