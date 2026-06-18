#!/usr/bin/env bash
set -euo pipefail

runtime_root="${PLANBRIDGE_TUNNEL_RUNTIME:-${PLANBRIDGE_RUNTIME_DIR:-$HOME/.planbridge}/tunnel-client}"
platform="${PLANBRIDGE_TUNNEL_PLATFORM:-}"

if [[ -z "$platform" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform="darwin-arm64" ;;
    Darwin-x86_64) platform="darwin-amd64" ;;
    Linux-arm64 | Linux-aarch64) platform="linux-arm64" ;;
    Linux-x86_64) platform="linux-amd64" ;;
    *) echo "Unsupported tunnel-client platform: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
  esac
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

release_json="$tmp/release.json"
curl -fsSL "https://api.github.com/repos/openai/tunnel-client/releases/latest" -o "$release_json"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$release_json")"
asset="tunnel-client-${version}-${platform}.zip"
asset_url="$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); name=sys.argv[2]; print(next(a["browser_download_url"] for a in r["assets"] if a["name"] == name))' "$release_json" "$asset")"
checksum_url="$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(next(a["browser_download_url"] for a in r["assets"] if a["name"] == "SHA256SUMS.txt"))' "$release_json")"

mkdir -p "$runtime_root/bin" "$runtime_root/downloads"
curl -fsSL "$checksum_url" -o "$tmp/SHA256SUMS.txt"
curl -fL "$asset_url" -o "$tmp/$asset"
grep -F "$asset" "$tmp/SHA256SUMS.txt" > "$tmp/checksum.txt"
(cd "$tmp" && shasum -a 256 -c "$tmp/checksum.txt")

unzip -q "$tmp/$asset" -d "$tmp/extract"
binary="$(find "$tmp/extract" -type f -name tunnel-client | head -n 1)"
if [[ -z "$binary" ]]; then
  echo "Downloaded asset did not contain a tunnel-client binary: $asset" >&2
  exit 1
fi

install -m 0755 "$binary" "$runtime_root/bin/tunnel-client-${version}-${platform}"
install -m 0755 "$binary" "$runtime_root/bin/tunnel-client"
printf '%s\n' "$version" > "$runtime_root/VERSION"
cp "$tmp/SHA256SUMS.txt" "$runtime_root/downloads/SHA256SUMS-${version}.txt"

echo "$runtime_root/bin/tunnel-client"
"$runtime_root/bin/tunnel-client" --version
