#!/usr/bin/env bash
set -euo pipefail

label="com.belnick-ai.planbridge-tunnel"
server_label="com.belnick-ai.planbridge"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
workspace_root="$(cd "$project_root/../../.." && pwd)"
domain="gui/$(id -u)"
source_plist="$workspace_root/00-work-here/launchd/$label.plist"
target_plist="$HOME/Library/LaunchAgents/$label.plist"
runtime_root="${PLANBRIDGE_TUNNEL_RUNTIME:-$workspace_root/shared-runtime/planbridge/tunnel-client}"
tunnel_client="${PLANBRIDGE_TUNNEL_CLIENT:-$runtime_root/bin/tunnel-client}"
profile="${PLANBRIDGE_TUNNEL_PROFILE:-planbridge-local-http}"
profile_dir="${PLANBRIDGE_TUNNEL_PROFILE_DIR:-$runtime_root/profiles}"
profile_file="$profile_dir/$profile.yaml"
health_file="${PLANBRIDGE_TUNNEL_HEALTH_URL_FILE:-$runtime_root/health.url}"
pid_file="${PLANBRIDGE_TUNNEL_PID_FILE:-$runtime_root/tunnel-client.pid}"
api_key_file="${PLANBRIDGE_TUNNEL_API_KEY_FILE:-$runtime_root/control-plane-api-key}"
config_file="${PLANBRIDGE_CONFIG:-${HOME:?HOME is required}/.planbridge/config.json}"

usage() {
  cat <<USAGE
Usage: scripts/planbridge-tunnel-service.sh <install|uninstall|start|stop|restart|status|run|logs|init>

Installs or controls the local PlanBridge tunnel-client LaunchAgent ($label).
The runtime key must be stored at:
  $api_key_file
USAGE
}

is_loaded() {
  launchctl print "$domain/$label" >/dev/null 2>&1
}

server_is_loaded() {
  launchctl print "$domain/$server_label" >/dev/null 2>&1
}

config_json() {
  node -e '
const fs = require("node:fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.connection?.kind !== "secure-tunnel") {
  console.error(`PlanBridge config must use secure-tunnel, found ${config.connection?.kind ?? "missing"}. Re-run setup with --tunnel-id.`);
  process.exit(2);
}
console.log(JSON.stringify({
  tunnelId: config.connection.tunnelId,
  mcpUrl: `http://127.0.0.1:${config.port ?? 7676}/mcp`
}));
' "$config_file"
}

tunnel_id() {
  node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.tunnelId)' "$(config_json)"
}

mcp_url() {
  node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.mcpUrl)' "$(config_json)"
}

check_tunnel_client() {
  if [[ ! -x "$tunnel_client" ]]; then
    echo "tunnel-client not found at $tunnel_client. Run npm run tunnel:install first." >&2
    exit 2
  fi
}

check_api_key_file() {
  if [[ ! -s "$api_key_file" ]]; then
    echo "Runtime API key file is missing or empty: $api_key_file" >&2
    exit 2
  fi
  chmod 600 "$api_key_file"
}

check_server() {
  local url status
  url="$(mcp_url)"
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
  if [[ "$status" != "405" && "$status" != "200" ]]; then
    echo "PlanBridge server is not reachable at $url; run npm run service:start first." >&2
    exit 2
  fi
}

start_server_service() {
  if ! server_is_loaded; then
    "$project_root/scripts/planbridge-service.sh" start
  else
    check_server
  fi
}

init_profile() {
  check_tunnel_client
  check_api_key_file
  mkdir -p "$profile_dir" "$(dirname "$health_file")" "$(dirname "$pid_file")"
  "$tunnel_client" init \
    --force \
    --sample sample_mcp_remote_no_auth \
    --profile "$profile" \
    --profile-dir "$profile_dir" \
    --tunnel-id "$(tunnel_id)" \
    --mcp-server-url "$(mcp_url)" \
    --control-plane-api-key-ref "file:$api_key_file" \
    --health-listen-addr "127.0.0.1:0"
}

probe_tunnel() {
  local base_url=""
  for _ in {1..40}; do
    if [[ -f "$health_file" ]]; then
      base_url="$(cat "$health_file")"
      if curl -fsS "$base_url/readyz" >/dev/null 2>&1; then
        echo "$label ready at $base_url/readyz"
        echo "$base_url/ui"
        return 0
      fi
    fi
    sleep 0.5
  done
  echo "$label did not become ready; inspect logs with npm run tunnel:service:logs" >&2
  return 1
}

stop_stale_pid() {
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" || true
    fi
    rm -f "$pid_file"
  fi
  rm -f "$health_file"
}

install_service() {
  if [[ ! -f "$source_plist" ]]; then
    echo "Missing source plist: $source_plist" >&2
    exit 2
  fi
  start_server_service
  init_profile
  mkdir -p "$(dirname "$target_plist")" "$runtime_root"
  cp "$source_plist" "$target_plist"
  plutil -lint "$target_plist"
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  stop_stale_pid
  launchctl bootstrap "$domain" "$target_plist"
  launchctl enable "$domain/$label"
  launchctl kickstart -kp "$domain/$label" >/dev/null
  probe_tunnel
  status
}

start_service() {
  start_server_service
  init_profile
  stop_stale_pid
  if ! is_loaded; then
    if [[ ! -f "$target_plist" ]]; then
      echo "LaunchAgent is not installed. Run npm run tunnel:service:install first." >&2
      exit 2
    fi
    launchctl bootstrap "$domain" "$target_plist"
    launchctl enable "$domain/$label"
  fi
  launchctl kickstart -kp "$domain/$label" >/dev/null
  probe_tunnel
  status
}

stop_service() {
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  stop_stale_pid
  echo "$label stopped"
}

status() {
  if is_loaded; then
    launchctl print "$domain/$label" | sed -n '1,80p'
  else
    echo "$label is not loaded in $domain"
    return 1
  fi
  if [[ -f "$health_file" ]]; then
    local base_url
    base_url="$(cat "$health_file")"
    curl -fsS "$base_url/readyz"
    printf '\n%s/ui\n' "$base_url"
  fi
}

run_service() {
  check_tunnel_client
  check_api_key_file
  check_server
  if [[ ! -f "$profile_file" ]]; then
    init_profile
  fi
  mkdir -p "$(dirname "$health_file")" "$(dirname "$pid_file")"
  exec "$tunnel_client" run \
    --profile-dir "$profile_dir" \
    --profile "$profile" \
    --health.listen-addr "127.0.0.1:0" \
    --health.url-file "$health_file" \
    --pid.file "$pid_file"
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
  run)
    run_service
    ;;
  logs)
    mkdir -p "$runtime_root"
    tail -n 120 -f "$runtime_root/launchd.out.log" "$runtime_root/launchd.err.log"
    ;;
  init)
    init_profile
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
