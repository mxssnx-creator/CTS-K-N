# Security model

## Trust boundaries

| Boundary | Controls |
| --- | --- |
| Browser → admin/install APIs | `ADMIN_SECRET` bearer and input validation |
| Scheduler → cron routes | `CRON_SECRET`, unauthenticated rejection, minute dedup |
| Kilo → long-lived install owner | fixed HTTPS owner URL, distinct origin, owner bearer |
| API host → remote server | SSH host validation, key/password handling, BatchMode/noninteractive sudo |
| Application → Redis | shared durable backend, TLS-capable URL/REST token, live gate |
| Application → exchange | credentials, explicit intent, readiness, locks, idempotent client IDs |
| Stored sensitive values | `ENCRYPTION_KEY`, authenticated AES-256-GCM envelope |
| Session tokens | `JWT_SECRET`, HTTP-only cookie, secure cookie in production |

## Secret rules

- Generate admin, cron, encryption and JWT secrets with a cryptographic random
  source; 32 random bytes is the standard installer output.
- Store production secrets in the platform secret manager or mode-600 host env
  file. Do not commit them.
- The Kilo deploy controller uploads only its explicit application-binding
  allowlist. Cloudflare API token/account ID never cross into Worker runtime.
- Remote install seed values travel in SSH stdin and a temporary mode-600 file,
  not process command arguments.
- Seed files block environment names that can inject shell/runtime behavior,
  including PATH/HOME/LD/NODE controls and live-forcing flags.
- Rotate secrets with a planned restart/recoordination. Rotating encryption
  keys requires re-encrypting or retaining a controlled decryption path for
  existing ciphertext.

## Encryption

New `SecurityManager` ciphertext uses:

```text
v2:<12-byte IV hex>:<16-byte GCM auth tag hex>:<ciphertext hex>
```

The AES-256 key is SHA-256-derived from the configured secret, so documented
hex/base64/random secrets of arbitrary reasonable length work. Authentication
failure throws; encryption/decryption never silently returns plaintext or
ciphertext as a successful result. Legacy two-part AES-CBC envelopes remain
readable with their original exact key.

## Live-order safety

Real placement requires all configured safety gates. Important invariants:

- requested real mode failing readiness is rejected, never paper fallback;
- shared durable Redis is mandatory for cross-instance locks/outboxes;
- exactly one authoritative position per symbol/direction;
- deterministic client IDs plus pre-submit outbox;
- fill confirmation before Set counting or protection sizing;
- reduce-only SL/TP and reconciliation;
- active exact Sets retained until terminal state;
- Block/DCA only attach to a confirmed parent;
- installer never sets `FORCE_LIVE` or placement overrides.

## Hardened live smoke

A real exchange smoke is permitted only with explicit user authorization,
valid credentials, an initially flat account, and the dedicated hardened admin
path. The procedure must:

1. acquire account-wide smoke lock;
2. re-check no positions/open orders;
3. use the exchange minimum practical amount;
4. open one position with deterministic client ID;
5. confirm fill and both protection orders;
6. close reduce-only;
7. cancel/reconcile remaining orders;
8. prove final account position and open-order state are flat;
9. preserve logs/evidence and release the lock.

Ordinary test scripts must keep live order placement disabled.

## Remote installation safety

The administrative route rejects unauthorized requests before body parsing.
It limits request/log size, validates and bounds every field, rejects embedded
repository credentials and dangerous install directories, requires a clean
fast-forward checkout, and uses the canonical fail-closed installer. On Kilo it
cannot spawn SSH and will only proxy to the configured owner.

Host service code is group-readable but not writable by the runtime user.
Only `.next/cache`, logs/data and service-home runtime areas are writable. The
services run with `NoNewPrivileges` and a private temp directory.

## Remaining operational responsibilities

Use least-privilege exchange keys, IP restrictions where supported, least-
privilege Cloudflare tokens, TLS Redis, host firewall/SSH policy, secret
rotation, encrypted backups, dependency review and audit-log retention. The
repository cannot provision account-side exchange/Cloudflare/DNS policies.
