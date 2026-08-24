#!/usr/bin/env bash
# Open the CTS-K-N maintenance SSH path through the Chisel server.
#
# Work-mode assigns a fresh egress proxy listener per command process. The
# proxy must be read and used in this same process namespace.
#
# This helper never persists Chisel authentication or SSH private keys.

set -Eeuo pipefail
umask 077

SERVER_URL="http://152.53.114.112:8090"
FINGERPRINT="Q0MxL4WHKwM2JbRy6/6fAUee3600R7pPo1CKov8/EPc="
REMOTE_USER="root"
REMOTE_PORT="22"
LOCAL_HOST="127.0.0.1"
LOCAL_PORT="2222"
REMOTE_TARGET="127.0.0.1:22"
CHISEL_BIN="chisel"
SSH_BIN="ssh"
PROXY=""
AUTH=""
AUTH_FILE=""
SSH_KEY=""
KNOWN_HOSTS=""

usage() {
  cat <<'EOF'
Usage:
  scripts/connect-remote-chisel.sh [options] [-- SSH_ARGS...]

Starts Chisel through the proxy assigned to this process and runs SSH through
the resulting local forward. With no trailing SSH arguments it opens an
interactive root shell.

Required:
  --ssh-key PATH          SSH private key for the server
  --known-hosts PATH      known_hosts containing [127.0.0.1]:2222
  --auth-file PATH        file containing the Chisel auth value (owner-only)
  or CTS_CHISEL_AUTH      Chisel auth value supplied in the environment

Options:
  --proxy URL             process-local HTTP/SOCKS proxy (default: HTTP_PROXY)
  --server-url URL        Chisel server URL
  --fingerprint VALUE     expected Chisel server fingerprint
  --user NAME             remote SSH user (default: root)
  --port PORT             remote port behind the forward (default: 22)
  --local-port PORT       local forward port (default: 2222)
  --chisel PATH           Chisel executable (default: chisel in PATH)
  --ssh PATH              SSH executable (default: ssh in PATH)
  --help                  show this help

The auth value and private key are not written by this helper. Host-key
checking is strict and the proxy value must be from this same process.
EOF
}

read_env() {
  local name="$1"
  printenv "$name" 2>/dev/null || true
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( 1 <= 10#$1 && 10#$1 <= 65535 ))
}

while (($#)); do
  case "$1" in
    --proxy)
      [[ $# -ge 2 ]] || { echo "--proxy requires a value" >&2; exit 2; }
      PROXY="$2"
      shift 2
      ;;
    --server-url)
      [[ $# -ge 2 ]] || { echo "--server-url requires a value" >&2; exit 2; }
      SERVER_URL="$2"
      shift 2
      ;;
    --fingerprint)
      [[ $# -ge 2 ]] || { echo "--fingerprint requires a value" >&2; exit 2; }
      FINGERPRINT="$2"
      shift 2
      ;;
    --auth-file)
      [[ $# -ge 2 ]] || { echo "--auth-file requires a value" >&2; exit 2; }
      AUTH_FILE="$2"
      shift 2
      ;;
    --ssh-key)
      [[ $# -ge 2 ]] || { echo "--ssh-key requires a value" >&2; exit 2; }
      SSH_KEY="$2"
      shift 2
      ;;
    --known-hosts)
      [[ $# -ge 2 ]] || { echo "--known-hosts requires a value" >&2; exit 2; }
      KNOWN_HOSTS="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || { echo "--user requires a value" >&2; exit 2; }
      REMOTE_USER="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "--port requires a value" >&2; exit 2; }
      REMOTE_PORT="$2"
      shift 2
      ;;
    --local-port)
      [[ $# -ge 2 ]] || { echo "--local-port requires a value" >&2; exit 2; }
      LOCAL_PORT="$2"
      shift 2
      ;;
    --chisel)
      [[ $# -ge 2 ]] || { echo "--chisel requires a value" >&2; exit 2; }
      CHISEL_BIN="$2"
      shift 2
      ;;
    --ssh)
      [[ $# -ge 2 ]] || { echo "--ssh requires a value" >&2; exit 2; }
      SSH_BIN="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Unknown option: $1 (put SSH arguments after --)" >&2
      exit 2
      ;;
  esac
done

[[ -n "$PROXY" ]] || PROXY="$(read_env CTS_CHISEL_PROXY)"
[[ -n "$PROXY" ]] || PROXY="$(read_env HTTP_PROXY)"
[[ -n "$PROXY" ]] || PROXY="$(read_env http_proxy)"
[[ -n "$PROXY" ]] || {
  echo "No process-local HTTP/SOCKS proxy found." >&2
  exit 2
}

AUTH="$(read_env CTS_CHISEL_AUTH)"
[[ -n "$AUTH_FILE" ]] || AUTH_FILE="$(read_env CTS_CHISEL_AUTH_FILE)"
if [[ -z "$AUTH" && -n "$AUTH_FILE" ]]; then
  [[ -r "$AUTH_FILE" ]] || { echo "Chisel auth file is not readable: $AUTH_FILE" >&2; exit 2; }
  auth_mode="$(stat -c '%a' "$AUTH_FILE" 2>/dev/null || true)"
  [[ "$auth_mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$auth_mode & 077) == 0 )) \
    || { echo "Chisel auth file must be owner-only: $AUTH_FILE" >&2; exit 2; }
  IFS= read -r AUTH < "$AUTH_FILE"
fi
if [[ -z "$AUTH" && -t 0 ]]; then
  read -r -s -p "Chisel auth: " AUTH
  printf '\n' >&2
fi
[[ -n "$AUTH" ]] || { echo "Missing Chisel auth; use CTS_CHISEL_AUTH or --auth-file." >&2; exit 2; }

[[ -n "$SSH_KEY" ]] || SSH_KEY="$(read_env CTS_SSH_KEY)"
[[ -n "$SSH_KEY" ]] || { echo "Missing SSH key; use CTS_SSH_KEY or --ssh-key." >&2; exit 2; }
[[ -r "$SSH_KEY" ]] || { echo "SSH key is not readable: $SSH_KEY" >&2; exit 2; }
[[ -n "$KNOWN_HOSTS" ]] || KNOWN_HOSTS="$(read_env CTS_SSH_KNOWN_HOSTS)"
[[ -n "$KNOWN_HOSTS" ]] || KNOWN_HOSTS="$HOME/.ssh/known_hosts"
[[ -r "$KNOWN_HOSTS" ]] || { echo "known_hosts is not readable: $KNOWN_HOSTS" >&2; exit 2; }

valid_port "$REMOTE_PORT" || { echo "Invalid remote port: $REMOTE_PORT" >&2; exit 2; }
valid_port "$LOCAL_PORT" || { echo "Invalid local port: $LOCAL_PORT" >&2; exit 2; }
[[ "$REMOTE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] || { echo "Invalid remote user" >&2; exit 2; }
command -v "$CHISEL_BIN" >/dev/null 2>&1 || { echo "Chisel executable not found: $CHISEL_BIN" >&2; exit 2; }
command -v "$SSH_BIN" >/dev/null 2>&1 || { echo "SSH executable not found: $SSH_BIN" >&2; exit 2; }

if timeout 1 bash -c "exec 3<>/dev/tcp/$LOCAL_HOST/$LOCAL_PORT" >/dev/null 2>&1; then
  echo "Local forward port is already in use: $LOCAL_HOST:$LOCAL_PORT" >&2
  exit 1
fi

run_dir="$(mktemp -d "/tmp/cts-chisel.XXXXXX")"
log_file="$run_dir/chisel.log"
chisel_pid=""
cleanup() {
  if [[ -n "$chisel_pid" ]]; then
    kill "$chisel_pid" 2>/dev/null || true
    wait "$chisel_pid" 2>/dev/null || true
  fi
  rm -rf -- "$run_dir"
}
trap cleanup EXIT INT TERM

"$CHISEL_BIN" client \
  --proxy "$PROXY" \
  --keepalive 25s \
  --fingerprint "$FINGERPRINT" \
  --auth "$AUTH" \
  "$SERVER_URL" \
  "$LOCAL_HOST:$LOCAL_PORT:$REMOTE_TARGET" \
  >"$log_file" 2>&1 &
chisel_pid="$!"

connected=0
for _ in $(seq 1 120); do
  if grep -q 'Connected (Latency' "$log_file"; then
    connected=1
    break
  fi
  if ! kill -0 "$chisel_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if (( connected != 1 )); then
  sed -E 's/(--auth)(=| +)[^ ]+/\1 <redacted>/g' "$log_file" >&2 || true
  if grep -q 'Authentication failed' "$log_file"; then
    echo "Endpoint and fingerprint were reached, but chisel-server rejected the supplied auth value." >&2
    echo "Confirm the active server-unit auth; do not disable fingerprint verification." >&2
  fi
  echo "Chisel did not establish the tunnel in this process context." >&2
  exit 1
fi

grep -E 'Fingerprint |Connected \(Latency' "$log_file" || true
"$SSH_BIN" \
  -i "$SSH_KEY" \
  -p "$LOCAL_PORT" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" \
  -o ConnectTimeout=15 \
  "$REMOTE_USER@$LOCAL_HOST" "$@"
