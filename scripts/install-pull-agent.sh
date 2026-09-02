#!/usr/bin/env bash
# Install a fail-closed systemd timer that updates one already-installed
# CTS-K-N checkout through the canonical clean update lifecycle. The timer
# never stores exchange credentials and refuses a dirty checkout or a forced
# remote history rewrite.

set -Eeuo pipefail
umask 027

APP_NAME="${CTS_PROJECT_NAME:-cts-kn}"
PROJECT_ROOT="${CTS_INSTALL_DIR:-}"
APP_PORT="${CTS_PORT:-3002}"
SERVICE_USER="${CTS_SERVICE_USER:-}"
ENV_FILE="${CTS_ENV_FILE:-}"
REPOSITORY="${CTS_REPOSITORY:-https://github.com/mxssnx-creator/CTS-K-N.git}"
BRANCH="${CTS_BRANCH:-main}"
PULL_INTERVAL="${CTS_PULL_AGENT_INTERVAL:-15min}"
PULL_ON_BOOT="${CTS_PULL_AGENT_ON_BOOT:-3min}"
UNINSTALL=0

usage() {
  cat <<'EOF'
Usage: scripts/install-pull-agent.sh [options]

Install or remove a systemd timer that fetches the configured remote branch
and delegates approved fast-forward updates to scripts/update.sh.

Options:
  --dir PATH           Existing CTS-K-N installation (default: /opt/<name>)
  --name NAME          Installed systemd service name (default: cts-kn)
  --port PORT          Installed HTTP port (default: 3002)
  --service-user USER  Installed runtime user (default: <name>)
  --env-file PATH      Existing external production environment under /etc
  --repository URL     Expected Git origin
  --branch NAME        Approved remote branch (default: main)
  --interval DURATION  Minimum time after a completed run (default: 15min)
  --on-boot DURATION   First check after boot (default: 3min)
  --uninstall          Remove only the pull-agent units/configuration
  --help               Show this help

The production environment must already be owner-only or read-only for its
service group (0600 or 0640). The timer preserves it and never reads, logs, or
writes exchange secrets.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) PROJECT_ROOT="${2:?--dir requires a value}"; shift 2 ;;
    --name) APP_NAME="${2:?--name requires a value}"; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
    --repository) REPOSITORY="${2:?--repository requires a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch requires a value}"; shift 2 ;;
    --interval) PULL_INTERVAL="${2:?--interval requires a value}"; shift 2 ;;
    --on-boot) PULL_ON_BOOT="${2:?--on-boot requires a value}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_user() { [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}
valid_branch() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ && "$1" != *".."* && "$1" != *"//"* ]]; }
valid_duration() { [[ "$1" =~ ^[1-9][0-9]*(us|ms|s|sec|m|min|h|hr|d|day)$ ]]; }
valid_repository() { [[ -n "$1" && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *[[:space:]]* ]]; }

[[ -n "$PROJECT_ROOT" ]] || PROJECT_ROOT="/opt/$APP_NAME"
[[ -n "$SERVICE_USER" ]] || SERVICE_USER="$APP_NAME"
[[ -n "$ENV_FILE" ]] || ENV_FILE="/etc/$APP_NAME/production.env"

valid_name "$APP_NAME" || { echo "Invalid app name: $APP_NAME" >&2; exit 2; }
valid_user "$SERVICE_USER" || { echo "Invalid service user: $SERVICE_USER" >&2; exit 2; }
valid_port "$APP_PORT" || { echo "Invalid HTTP port: $APP_PORT" >&2; exit 2; }
valid_absolute_path "$PROJECT_ROOT" && [[ "$PROJECT_ROOT" == /opt/* ]] \
  || { echo "Install directory must be a safe path under /opt: $PROJECT_ROOT" >&2; exit 2; }
valid_absolute_path "$ENV_FILE" && [[ "$ENV_FILE" == /etc/* ]] \
  || { echo "Environment file must be a safe path under /etc: $ENV_FILE" >&2; exit 2; }
valid_repository "$REPOSITORY" || { echo "Invalid repository URL" >&2; exit 2; }
valid_branch "$BRANCH" || { echo "Invalid branch: $BRANCH" >&2; exit 2; }
valid_duration "$PULL_INTERVAL" || { echo "Invalid systemd interval: $PULL_INTERVAL" >&2; exit 2; }
valid_duration "$PULL_ON_BOOT" || { echo "Invalid systemd boot delay: $PULL_ON_BOOT" >&2; exit 2; }

if (( EUID != 0 )); then
  echo "Run this installer as root (for example: sudo bash scripts/install-pull-agent.sh ...)" >&2
  exit 1
fi
command -v systemctl >/dev/null 2>&1 || { echo "systemd is required for the pull agent" >&2; exit 1; }

CONFIG_DIR="/etc/$APP_NAME"
PULL_ENV_FILE="$CONFIG_DIR/pull-agent.env"
RUNNER_PATH="/usr/local/sbin/$APP_NAME-pull-agent"
SERVICE_UNIT_NAME="$APP_NAME-pull-agent.service"
TIMER_UNIT_NAME="$APP_NAME-pull-agent.timer"
SERVICE_UNIT="/etc/systemd/system/$SERVICE_UNIT_NAME"
TIMER_UNIT="/etc/systemd/system/$TIMER_UNIT_NAME"

if (( UNINSTALL == 1 )); then
  systemctl disable --now "$TIMER_UNIT_NAME" "$SERVICE_UNIT_NAME" 2>/dev/null || true
  rm -f -- "$TIMER_UNIT" "$SERVICE_UNIT" "$RUNNER_PATH" "$PULL_ENV_FILE"
  rmdir --ignore-fail-on-non-empty "$CONFIG_DIR" 2>/dev/null || true
  systemctl daemon-reload
  echo "Removed pull agent for $APP_NAME; the CTS installation and production environment were preserved."
  exit 0
fi

command -v git >/dev/null 2>&1 || { echo "git is required for the pull agent" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required for the pull agent" >&2; exit 1; }

[[ -d "$PROJECT_ROOT/.git" && -f "$PROJECT_ROOT/package.json" && -f "$PROJECT_ROOT/scripts/update.sh" ]] \
  || { echo "Not a complete existing CTS-K-N checkout: $PROJECT_ROOT" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Expected external production environment is missing: $ENV_FILE" >&2; exit 1; }
env_mode="$(stat -c '%a' "$ENV_FILE")"
[[ "$env_mode" =~ ^[0-7]{3,4}$ ]] || { echo "Cannot read permissions for $ENV_FILE" >&2; exit 1; }
env_mode_bits=$((8#$env_mode & 0777))
(( env_mode_bits == 0600 || env_mode_bits == 0640 )) \
  || { echo "Production environment must be 0600 or service-group-readable 0640: $ENV_FILE" >&2; exit 1; }
current_origin="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
[[ "$current_origin" == "$REPOSITORY" ]] \
  || { echo "Checkout origin does not match the configured repository" >&2; exit 1; }

install -d -m 0750 "$CONFIG_DIR"
{
  printf 'CTS_PULL_AGENT_ENABLED=1\n'
  printf 'CTS_PULL_AGENT_INSTALL_DIR=%s\n' "$PROJECT_ROOT"
  printf 'CTS_PULL_AGENT_APP_NAME=%s\n' "$APP_NAME"
  printf 'CTS_PULL_AGENT_PORT=%s\n' "$APP_PORT"
  printf 'CTS_PULL_AGENT_SERVICE_USER=%s\n' "$SERVICE_USER"
  printf 'CTS_PULL_AGENT_ENV_FILE=%s\n' "$ENV_FILE"
  printf 'CTS_PULL_AGENT_REPOSITORY=%s\n' "$REPOSITORY"
  printf 'CTS_PULL_AGENT_BRANCH=%s\n' "$BRANCH"
} > "$PULL_ENV_FILE"
chmod 0600 "$PULL_ENV_FILE"

tee "$RUNNER_PATH" >/dev/null <<'RUNNER'
#!/usr/bin/env bash
# Installed by scripts/install-pull-agent.sh. The systemd unit passes only
# the root-owned configuration path; secrets remain in the separate CTS env.

set -Eeuo pipefail
umask 027

log() {
  local tag="${CTS_PULL_AGENT_APP_NAME:-cts-kn}-pull-agent"
  if command -v logger >/dev/null 2>&1; then logger -t "$tag" -- "$*" || true; fi
  printf '[%s] %s\n' "$tag" "$*"
}
fatal() { log "FATAL: $*" >&2; exit 1; }
valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_user() { [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}
valid_branch() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ && "$1" != *".."* && "$1" != *"//"* ]]; }
valid_repository() { [[ -n "$1" && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *[[:space:]]* ]]; }

(( EUID == 0 )) || fatal "must run as root"
PULL_CONFIG_FILE="${CTS_PULL_AGENT_CONFIG_FILE:-}"
valid_absolute_path "$PULL_CONFIG_FILE" && [[ "$PULL_CONFIG_FILE" == /etc/* ]] \
  || fatal "missing or invalid CTS_PULL_AGENT_CONFIG_FILE"
[[ -r "$PULL_CONFIG_FILE" ]] || fatal "configuration is not readable: $PULL_CONFIG_FILE"
config_mode="$(stat -c '%a' "$PULL_CONFIG_FILE")"
config_owner="$(stat -c '%u' "$PULL_CONFIG_FILE")"
[[ "$config_mode" =~ ^[0-7]{3,4}$ && "$config_owner" == "0" ]] \
  || fatal "configuration must be root-owned with a readable permission mode"
(( (8#$config_mode & 077) == 0 )) \
  || fatal "configuration must be owner-only"
# This file is written by the root-only installer and contains no credentials.
set -a
# shellcheck disable=SC1090
source "$PULL_CONFIG_FILE"
set +a

[[ "${CTS_PULL_AGENT_ENABLED:-1}" == "1" ]] || { log "disabled by configuration"; exit 0; }
valid_name "${CTS_PULL_AGENT_APP_NAME:-}" || fatal "invalid configured app name"
valid_user "${CTS_PULL_AGENT_SERVICE_USER:-}" || fatal "invalid configured service user"
valid_port "${CTS_PULL_AGENT_PORT:-}" || fatal "invalid configured port"
valid_absolute_path "${CTS_PULL_AGENT_INSTALL_DIR:-}" \
  && [[ "$CTS_PULL_AGENT_INSTALL_DIR" == /opt/* ]] || fatal "invalid configured installation directory"
valid_absolute_path "${CTS_PULL_AGENT_ENV_FILE:-}" \
  && [[ "$CTS_PULL_AGENT_ENV_FILE" == /etc/* ]] || fatal "invalid configured production environment"
valid_repository "${CTS_PULL_AGENT_REPOSITORY:-}" || fatal "invalid configured repository"
valid_branch "${CTS_PULL_AGENT_BRANCH:-}" || fatal "invalid configured branch"
[[ -f "$CTS_PULL_AGENT_ENV_FILE" ]] || fatal "production environment is missing"
env_mode="$(stat -c '%a' "$CTS_PULL_AGENT_ENV_FILE")"
[[ "$env_mode" =~ ^[0-7]{3,4}$ ]] || fatal "cannot read production environment permissions"
env_mode_bits=$((8#$env_mode & 0777))
(( env_mode_bits == 0600 || env_mode_bits == 0640 )) \
  || fatal "production environment must remain 0600 or service-group-readable 0640"
[[ -d "$CTS_PULL_AGENT_INSTALL_DIR/.git" && -f "$CTS_PULL_AGENT_INSTALL_DIR/scripts/update.sh" ]] \
  || fatal "installed checkout is incomplete"
command -v git >/dev/null 2>&1 || fatal "git is unavailable"
command -v flock >/dev/null 2>&1 || fatal "flock is unavailable"

exec 9>"/run/${CTS_PULL_AGENT_APP_NAME}-pull-agent.lock"
flock -n 9 || { log "another update check is already running"; exit 0; }

origin="$(git -C "$CTS_PULL_AGENT_INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
[[ "$origin" == "$CTS_PULL_AGENT_REPOSITORY" ]] || fatal "checkout origin changed; refusing update"
current_branch="$(git -C "$CTS_PULL_AGENT_INSTALL_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$current_branch" == "$CTS_PULL_AGENT_BRANCH" ]] || fatal "checkout is not on the configured branch"
[[ -z "$(git -C "$CTS_PULL_AGENT_INSTALL_DIR" status --porcelain --untracked-files=no)" ]] \
  || fatal "tracked local changes exist; refusing to overwrite them"

git -C "$CTS_PULL_AGENT_INSTALL_DIR" fetch --prune --no-tags origin \
  "refs/heads/$CTS_PULL_AGENT_BRANCH:refs/remotes/origin/$CTS_PULL_AGENT_BRANCH"
current="$(git -C "$CTS_PULL_AGENT_INSTALL_DIR" rev-parse --verify HEAD^{commit})"
target="$(git -C "$CTS_PULL_AGENT_INSTALL_DIR" rev-parse --verify "refs/remotes/origin/$CTS_PULL_AGENT_BRANCH^{commit}")"
if [[ "$current" == "$target" ]]; then
  log "already current at ${current:0:12}"
  exit 0
fi
git -C "$CTS_PULL_AGENT_INSTALL_DIR" merge-base --is-ancestor "$current" "$target" \
  || fatal "remote branch is not a fast-forward; refusing replacement"

log "applying fast-forward ${current:0:12} -> ${target:0:12} through canonical update lifecycle"
exec env \
  CTS_INSTALL_DIR="$CTS_PULL_AGENT_INSTALL_DIR" \
  CTS_PROJECT_NAME="$CTS_PULL_AGENT_APP_NAME" \
  CTS_PORT="$CTS_PULL_AGENT_PORT" \
  CTS_RUNTIME=systemd \
  CTS_SERVICE_USER="$CTS_PULL_AGENT_SERVICE_USER" \
  CTS_ENV_FILE="$CTS_PULL_AGENT_ENV_FILE" \
  CTS_REPOSITORY="$CTS_PULL_AGENT_REPOSITORY" \
  CTS_BRANCH="$CTS_PULL_AGENT_BRANCH" \
  CTS_INSTALL_SEARCH_ROOT=/opt \
  bash "$CTS_PULL_AGENT_INSTALL_DIR/scripts/update.sh" \
    --dir "$CTS_PULL_AGENT_INSTALL_DIR" \
    --name "$CTS_PULL_AGENT_APP_NAME" \
    --port "$CTS_PULL_AGENT_PORT" \
    --runtime systemd \
    --service-user "$CTS_PULL_AGENT_SERVICE_USER" \
    --env-file "$CTS_PULL_AGENT_ENV_FILE" \
    --repository "$CTS_PULL_AGENT_REPOSITORY" \
    --branch "$CTS_PULL_AGENT_BRANCH"
RUNNER
chmod 0750 "$RUNNER_PATH"

tee "$SERVICE_UNIT" >/dev/null <<EOF
[Unit]
Description=CTS-K-N fail-closed Git pull/update agent
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=root
Group=root
Environment=CTS_PULL_AGENT_CONFIG_FILE=$PULL_ENV_FILE
ExecStart=$RUNNER_PATH
TimeoutStartSec=45min
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
PrivateTmp=true
EOF

tee "$TIMER_UNIT" >/dev/null <<EOF
[Unit]
Description=Run the CTS-K-N pull/update agent periodically

[Timer]
OnBootSec=$PULL_ON_BOOT
OnUnitInactiveSec=$PULL_INTERVAL
RandomizedDelaySec=90s
Persistent=true
Unit=$SERVICE_UNIT_NAME

[Install]
WantedBy=timers.target
EOF

chmod 0644 "$SERVICE_UNIT" "$TIMER_UNIT"
systemctl daemon-reload
systemctl enable --now "$TIMER_UNIT"
systemctl reset-failed "$SERVICE_UNIT_NAME" 2>/dev/null || true

echo "Installed $TIMER_UNIT_NAME. It updates only clean, fast-forwardable $BRANCH revisions through scripts/update.sh."
systemctl list-timers "$TIMER_UNIT_NAME" --no-pager
