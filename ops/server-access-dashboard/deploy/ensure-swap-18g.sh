#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

swap_file="/swapfile-cts-kn"
if [[ $# -ge 1 ]]; then
  swap_file="$1"
fi
target_bytes=$((18 * 1024 * 1024 * 1024))
fstab_line="$swap_file none swap sw 0 0"

if [[ "$swap_file" != /* || "$swap_file" == "/" ]]; then
  echo "refusing unsafe swap path: $swap_file" >&2
  exit 1
fi

if swapon --noheadings --show=NAME | awk '{print $1}' | grep -Fxq "$swap_file"; then
  actual_bytes=$(stat -c '%s' "$swap_file")
  if [[ "$actual_bytes" -ne "$target_bytes" ]]; then
    echo "active swap file has unexpected size; refusing to resize: $swap_file" >&2
    exit 1
  fi
else
  if [[ -e "$swap_file" ]]; then
    actual_bytes=$(stat -c '%s' "$swap_file")
    if [[ "$actual_bytes" -ne "$target_bytes" ]]; then
      echo "existing inactive file has unexpected size; refusing to overwrite: $swap_file" >&2
      exit 1
    fi
    if [[ "$(file -b "$swap_file" 2>/dev/null || true)" != *"swap file"* ]]; then
      echo "existing file is not recognized as swap; refusing: $swap_file" >&2
      exit 1
    fi
  else
    available_bytes=$(df -P -B1 "$(dirname "$swap_file")" | awk 'NR==2 {print $4}')
    if [[ -z "$available_bytes" || "$available_bytes" -lt $((target_bytes + 2 * 1024 * 1024 * 1024)) ]]; then
      echo "insufficient free space for an 18 GiB swap file plus safety margin" >&2
      exit 1
    fi
    install -m 600 /dev/null "$swap_file"
    fallocate -l "$target_bytes" "$swap_file"
    chmod 600 "$swap_file"
    mkswap "$swap_file" >/dev/null
  fi
  swapon "$swap_file"
fi

if ! grep -Fqx "$fstab_line" /etc/fstab 2>/dev/null; then
  printf '%s\n' "$fstab_line" >> /etc/fstab
fi

install -d -m 755 /etc/sysctl.d
if [[ ! -f /etc/sysctl.d/99-cts-kn-memory.conf ]]; then
  printf '%s\n' 'vm.swappiness=10' 'vm.vfs_cache_pressure=50' > /etc/sysctl.d/99-cts-kn-memory.conf
fi
sysctl --system >/dev/null

echo "persistent swap verification:"
swapon --show
free -h
grep -Fqx "$fstab_line" /etc/fstab
