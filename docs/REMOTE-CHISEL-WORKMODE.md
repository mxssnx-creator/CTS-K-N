# Remote CTS-K-N work through Chisel

This is the persistent connection procedure for the CTS-K-N remote Linux
server. It is intentionally credential-free: never commit the Chisel auth
value, an SSH private key, exchange credentials, Redis data, or raw account
reports.

## Why the working command is process-local

Work-mode gives each command process its own dynamically assigned egress proxy
listener. The value in HTTP_PROXY is valid only inside the process that
received it. A copied port from a previous command can be closed or belong to
another namespace. Chisel and SSH must therefore be launched by the same shell
process, using the inherited HTTP_PROXY value directly.

The helper scripts/connect-remote-chisel.sh enforces that sequence:

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

Common executable symlinks are under /workspace/.network-clients/bin.
Teleport, Tailscale, and NetBird remain optional alternatives; the confirmed
working route for this project is Chisel over the process-local HTTP proxy.
