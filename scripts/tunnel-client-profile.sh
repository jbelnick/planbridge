#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/tunnel-client-profile.sh <init|doctor|run|status>

Requires ~/.planbridge/config.json to use a secure-tunnel connection. Runtime
commands require either CONTROL_PLANE_API_KEY in the environment or a runtime
key file. The key is never printed by this script.
USAGE
}

command="${1:-}"
if [[ -z "$command" || "$command" == "-h" || "$command" == "--help" ]]; then
  usage
  exit 0
fi

runtime_root="${PLANBRIDGE_TUNNEL_RUNTIME:-${PLANBRIDGE_RUNTIME_DIR:-$HOME/.planbridge}/tunnel-client}"
tunnel_client="${PLANBRIDGE_TUNNEL_CLIENT:-$runtime_root/bin/tunnel-client}"
profile="${PLANBRIDGE_TUNNEL_PROFILE:-planbridge-local-http}"
profile_dir="${PLANBRIDGE_TUNNEL_PROFILE_DIR:-$runtime_root/profiles}"
health_file="${PLANBRIDGE_TUNNEL_HEALTH_URL_FILE:-$runtime_root/health.url}"
pid_file="${PLANBRIDGE_TUNNEL_PID_FILE:-$runtime_root/tunnel-client.pid}"
api_key_file="${PLANBRIDGE_TUNNEL_API_KEY_FILE:-$runtime_root/control-plane-api-key}"
api_key_ref="${PLANBRIDGE_TUNNEL_API_KEY_REF:-env:CONTROL_PLANE_API_KEY}"
config_file="${PLANBRIDGE_CONFIG:-${HOME:?HOME is required}/.planbridge/config.json}"

if [[ -z "${PLANBRIDGE_TUNNEL_API_KEY_REF:-}" && -s "$api_key_file" ]]; then
  api_key_ref="file:$api_key_file"
fi

if [[ ! -x "$tunnel_client" ]]; then
  echo "tunnel-client not found at $tunnel_client. Run npm run tunnel:install first." >&2
  exit 2
fi

config_json="$(node -e '
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
' "$config_file")"

tunnel_id="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.tunnelId)' "$config_json")"
mcp_url="$(node -e 'const data=JSON.parse(process.argv[1]); process.stdout.write(data.mcpUrl)' "$config_json")"
profile_file="$profile_dir/$profile.yaml"

init_profile() {
  mkdir -p "$profile_dir"
  "$tunnel_client" init \
    --force \
    --sample sample_mcp_remote_no_auth \
    --profile "$profile" \
    --profile-dir "$profile_dir" \
    --tunnel-id "$tunnel_id" \
    --mcp-server-url "$mcp_url" \
    --control-plane-api-key-ref "$api_key_ref" \
    --health-listen-addr "127.0.0.1:0"
}

ensure_profile() {
  if [[ ! -f "$profile_file" ]]; then
    init_profile
  fi
}

require_profile() {
  if [[ ! -f "$profile_file" ]]; then
    echo "Tunnel profile is missing at $profile_file. Run npm run tunnel:init first." >&2
    exit 2
  fi
}

require_runtime_key() {
  case "$api_key_ref" in
    env:*)
      local env_name="${api_key_ref#env:}"
      if [[ -z "${!env_name:-}" ]]; then
        echo "$env_name is not set. Use a runtime key with Tunnels Read + Use for $tunnel_id." >&2
        exit 2
      fi
      ;;
    file:*)
      local file_path="${api_key_ref#file:}"
      if [[ ! -s "$file_path" ]]; then
        echo "Runtime API key file is missing or empty: $file_path" >&2
        exit 2
      fi
      chmod 600 "$file_path"
      ;;
    *)
      echo "Unsupported tunnel API key ref: $api_key_ref" >&2
      exit 2
      ;;
  esac
}

check_server() {
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$mcp_url" || true)"
  if [[ "$status" != "405" && "$status" != "200" ]]; then
    echo "PlanBridge server is not reachable at $mcp_url; run npm run serve in another shell." >&2
    exit 2
  fi
}

case "$command" in
  init)
    init_profile
    ;;
  doctor)
    require_profile
    require_runtime_key
    check_server
    "$tunnel_client" doctor --profile-dir "$profile_dir" --profile "$profile" --explain
    ;;
  run)
    ensure_profile
    require_runtime_key
    check_server
    mkdir -p "$(dirname "$health_file")" "$(dirname "$pid_file")"
    exec "$tunnel_client" run \
      --profile-dir "$profile_dir" \
      --profile "$profile" \
      --health.listen-addr "127.0.0.1:0" \
      --health.url-file "$health_file" \
      --pid.file "$pid_file"
    ;;
  status)
    if [[ ! -f "$health_file" ]]; then
      echo "No tunnel-client health URL file found at $health_file." >&2
      exit 2
    fi
    base_url="$(cat "$health_file")"
    curl -fsS "$base_url/readyz"
    printf '\n%s/ui\n' "$base_url"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
