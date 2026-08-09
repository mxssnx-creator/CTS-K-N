#!/usr/bin/env bash
set -euo pipefail

# Install/authenticate GitHub CLI and keep the repository origin pointed at the
# requested GitHub repository. Designed for ephemeral CI/dev containers.
#
# Configure the target repository with one of:
#   GITHUB_REPOSITORY=OWNER/REPO
#   GITHUB_REMOTE_URL=https://github.com/OWNER/REPO.git
#   scripts/setup-github-cli.sh OWNER/REPO

ensure_github_cli() {
  if command -v gh >/dev/null 2>&1; then
    return 0
  fi

  # Prefer a system package on a normal Ubuntu/Debian host, but do not make
  # an otherwise valid checkout fail when apt's state is read-only (common in
  # containers and managed runners). The user-space install is persistent and
  # can be reused by later invocations.
  if command -v apt-get >/dev/null 2>&1 && [ -d /var/lib/apt/lists ] && [ -w /var/lib/apt/lists ]; then
    if apt-get update -y -qq && apt-get install -y -qq gh; then
      return 0
    fi
  fi

  command -v curl >/dev/null 2>&1 || {
    echo "GitHub CLI (gh) is missing and curl is unavailable for the persistent fallback." >&2
    return 1
  }
  command -v tar >/dev/null 2>&1 || {
    echo "GitHub CLI (gh) is missing and tar is unavailable for the persistent fallback." >&2
    return 1
  }

  local install_root="${GH_INSTALL_ROOT:-/workspace/tools/github-cli}"
  local architecture
  case "$(uname -m)" in
    x86_64|amd64) architecture="amd64" ;;
    aarch64|arm64) architecture="arm64" ;;
    *)
      echo "Unsupported architecture for the persistent gh fallback: $(uname -m)" >&2
      return 1
      ;;
  esac

  local version="${GH_VERSION:-}"
  if [ -z "${version}" ]; then
    version="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
      | sed -n 's/.*\"tag_name\": \"\([^\"]*\)\".*/\1/p' | head -1)"
  fi
  version="${version#v}"
  [ -n "${version}" ] || {
    echo "Could not resolve a GitHub CLI release version." >&2
    return 1
  }

  local install_dir="${install_root}/${version}"
  if [ ! -x "${install_dir}/bin/gh" ]; then
    mkdir -p "${install_dir}"
    curl -fsSL "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_${architecture}.tar.gz" \
      -o "${install_dir}/gh_${version}.tar.gz"
    tar --no-same-owner --strip-components=1 -xzf "${install_dir}/gh_${version}.tar.gz" -C "${install_dir}"
  fi

  export PATH="${install_dir}/bin:${PATH}"
  gh --version >/dev/null
  echo "GitHub CLI installed persistently at ${install_dir}/bin/gh"
}

resolve_remote_url() {
  local repo="${1:-${GITHUB_REPOSITORY:-}}"

  if [ -n "${GITHUB_REMOTE_URL:-}" ]; then
    printf '%s\n' "${GITHUB_REMOTE_URL}"
    return 0
  fi

  if [ -n "${repo}" ]; then
    case "${repo}" in
      http://*|https://*|git@*) printf '%s\n' "${repo}" ;;
      *) printf 'https://github.com/%s.git\n' "${repo}" ;;
    esac
    return 0
  fi

  echo "Set GITHUB_REPOSITORY, GITHUB_REMOTE_URL, or pass OWNER/REPO." >&2
  return 1
}

configure_origin() {
  local remote_url="$1"

  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "${remote_url}"
  else
    git remote add origin "${remote_url}"
  fi
}

ensure_github_cli

if [ -n "${GITHUB_TOKEN:-}" ]; then
  github_token="${GITHUB_TOKEN}"
  unset GITHUB_TOKEN

  echo "${github_token}" | gh auth login --with-token
  gh auth setup-git
fi

remote_url="$(resolve_remote_url "${1:-}")"
configure_origin "${remote_url}"
