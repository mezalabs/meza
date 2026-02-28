#!/usr/bin/env bash
# cleanup.sh — Stop any running Meza services from previous runs.
# Called by: task cleanup (Taskfile.yml)
# Requires: PID_DIR environment variable
set -euo pipefail

: "${PID_DIR:?PID_DIR must be set}"

# Runtime dir is the parent of worktree-specific PID dirs
RUNTIME_DIR=$(dirname "$PID_DIR")

validate_meza_process() {
  local pid=$1
  kill -0 "$pid" 2>/dev/null || return 1
  local cmdline
  cmdline=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  [[ "$cmdline" =~ go\ run.*cmd/(gateway|auth|chat|presence|media|voice|keys) ]] && return 0
  [[ "$cmdline" =~ /exe/(gateway|auth|chat|presence|media|voice|keys) ]] && return 0
  [[ "$cmdline" =~ /bin/(gateway|auth|chat|presence|media|voice|keys) ]] && return 0
  [[ "$cmdline" =~ (pnpm|vite|node.*vite) ]] && return 0
  return 1
}

is_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

# PID-based cleanup: scan ALL worktree PID dirs (not just ours) to kill orphans
killed_pids=""
for pid_dir in "$RUNTIME_DIR"/meza-*/; do
  [[ -d "$pid_dir" ]] || continue

  prev_worktree=""
  if [[ -f "$pid_dir/worktree.txt" ]]; then
    prev_worktree=$(cat "$pid_dir/worktree.txt")
  fi

  for name in gateway auth chat presence media voice keys vite; do
    pidfile="$pid_dir/${name}.pid"
    [[ -f "$pidfile" && ! -L "$pidfile" ]] || continue
    pid=$(cat "$pidfile")
    [[ "$pid" =~ ^[0-9]+$ ]] || { rm -f "$pidfile"; continue; }
    (( pid > 1 )) || { rm -f "$pidfile"; continue; }
    if validate_meza_process "$pid"; then
      if [[ -n "$prev_worktree" ]]; then
        echo "Stopping Meza services (worktree: $prev_worktree)..."
        prev_worktree=""  # Only print once per worktree
      fi
      kill -- -"$pid" 2>/dev/null || true
      echo "  Stopping $name (PID $pid)"
      killed_pids="$killed_pids $pid"
    fi
    rm -f "$pidfile"
  done
done

# Shared wait: 3 seconds max total, then SIGKILL survivors
if [[ -n "$killed_pids" ]]; then
  for _ in 1 2 3; do
    alive=false
    for pid in $killed_pids; do
      is_pid_alive "$pid" && alive=true && break
    done
    $alive || break
    sleep 1
  done
  for pid in $killed_pids; do
    is_pid_alive "$pid" && kill -9 -- -"$pid" 2>/dev/null || true
  done
fi

# Port scan fallback for orphans without PID files
for port in 8080 8081 8082 8083 8084 8085 8088 4080; do
  pids=$(lsof -ti ":$port" 2>/dev/null) || true
  [[ -z "$pids" ]] && continue
  echo "$pids" | while read -r pid; do
    if validate_meza_process "$pid"; then
      kill "$pid" 2>/dev/null || true
      echo "  Stopped orphan on :$port (PID $pid)"
    else
      echo "  WARNING: Port :$port in use by non-Meza process (PID $pid)"
    fi
  done
done

# Clean stale worktree PID dirs (no remaining PID files = nothing running)
for pid_dir in "$RUNTIME_DIR"/meza-*/; do
  [[ -d "$pid_dir" ]] || continue
  if ! ls "$pid_dir"/*.pid 1>/dev/null 2>&1; then
    rm -rf "$pid_dir"
  fi
done
