# Sourced by release bootstraps that have already chosen their Node version.
install_release_node() {
  local release_node_version="$1"
  local release_node_dir="$RUNNER_TEMP/node-v$release_node_version-linux-x64"
  if [ ! -x "$release_node_dir/bin/node" ]; then
    curl --fail --show-error --location \
      --retry 5 --retry-all-errors --connect-timeout 15 --max-time 180 \
      "https://nodejs.org/dist/v$release_node_version/node-v$release_node_version-linux-x64.tar.gz" \
      -o "$RUNNER_TEMP/node.tar.gz"
    tar -xzf "$RUNNER_TEMP/node.tar.gz" -C "$RUNNER_TEMP"
  fi
  echo "$release_node_dir/bin" >> "$GITHUB_PATH"
  export PATH="$release_node_dir/bin:$PATH"
}
