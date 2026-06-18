#!/usr/bin/env bash
set -euo pipefail

label="com.belnick-ai.planbridge"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
workspace_root="$(cd "$project_root/../../.." && pwd)"
domain="gui/$(id -u)"
source_plist="$workspace_root/00-work-here/launchd/$label.plist"
target_plist="$HOME/Library/LaunchAgents/$label.plist"
runtime_root="$workspace_root/shared-runtime/planbridge/server"

usage() {
  cat <<USAGE
Usage: scripts/planbridge-service.sh <install|uninstall|start|stop|restart|status|logs>

Installs or controls the local PlanBridge LaunchAgent ($label).
USAGE
}

is_loaded() {
  launchctl print "$domain/$label" >/dev/null 2>&1
}

status() {
  if is_loaded; then
    launchctl print "$domain/$label" | sed -n '1,80p'
  else
    echo "$label is not loaded in $domain"
    return 1
  fi
}

build_project() {
  (cd "$project_root" && npm run build)
}

config_port() {
  (cd "$project_root" && node --input-type=module -e '
    import path from "node:path";
    import { assertDirectoryExists, loadConfig } from "./dist/src/config.js";
    const config = await loadConfig(process.env);
    await assertDirectoryExists(config.projectsRoot, "projects root");
    for (const project of config.allowlist) {
      await assertDirectoryExists(path.join(config.projectsRoot, project), "allowlisted project");
    }
    process.stdout.write(String(config.port));
  ')
}

assert_port_available() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use; refusing to start $label." >&2
    return 1
  fi
}

probe_service() {
  local port="$1"
  local status_code=""
  for _ in {1..20}; do
    status_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/mcp" 2>/dev/null || true)"
    if [[ "$status_code" == "405" || "$status_code" == "200" ]]; then
      echo "$label reachable at http://127.0.0.1:$port/mcp ($status_code)"
      return 0
    fi
    sleep 0.5
  done
  echo "$label did not become reachable at http://127.0.0.1:$port/mcp; last status: ${status_code:-none}" >&2
  return 1
}

install_service() {
  if [[ ! -f "$source_plist" ]]; then
    echo "Missing source plist: $source_plist" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$target_plist")" "$runtime_root"
  build_project
  local port
  port="$(config_port)"
  cp "$source_plist" "$target_plist"
  plutil -lint "$target_plist"
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  assert_port_available "$port"
  launchctl bootstrap "$domain" "$target_plist"
  launchctl enable "$domain/$label"
  launchctl kickstart -kp "$domain/$label" >/dev/null
  probe_service "$port"
  status
}

start_service() {
  local port
  build_project
  port="$(config_port)"
  if ! is_loaded; then
    if [[ ! -f "$target_plist" ]]; then
      echo "LaunchAgent is not installed. Run npm run service:install first." >&2
      exit 2
    fi
    assert_port_available "$port"
    launchctl bootstrap "$domain" "$target_plist"
    launchctl enable "$domain/$label"
  fi
  launchctl kickstart -kp "$domain/$label" >/dev/null
  probe_service "$port"
  status
}

stop_service() {
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  echo "$label stopped"
}

case "${1:-}" in
  install)
    install_service
    ;;
  uninstall)
    stop_service
    rm -f "$target_plist"
    echo "removed $target_plist"
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status
    ;;
  logs)
    mkdir -p "$runtime_root"
    tail -n 120 -f "$runtime_root/launchd.out.log" "$runtime_root/launchd.err.log"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
