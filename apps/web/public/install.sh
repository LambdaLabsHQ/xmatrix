#!/usr/bin/env bash
set -euo pipefail

# Environment:
#   XMATRIX_INSTALL_DIR     Visible command directory (default: ~/.local/bin)
#   XMATRIX_BIN_NAME        Installed command name (default: xmatrix)
#   XMATRIX_RELEASE_API_URL Release metadata URL
#   XMATRIX_SKIP_DAEMON_AUTOSTART
# The installer never uses sudo. System locations such as /usr/local/bin are
# only used when XMATRIX_INSTALL_DIR points at a directory the user can write.

# Terminal styling
if test -t 1 2>/dev/null; then
  BOLD="\033[1m"
  DIM="\033[2m"
  RED="\033[31m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  BLUE="\033[34m"
  CYAN="\033[36m"
  RESET="\033[0m"
else
  BOLD=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  CYAN=""
  RESET=""
fi

info() { echo -e "  ${CYAN}•${RESET} $1"; }
step() { echo -e "  ${CYAN}○${RESET} $1"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
error() { echo -e "  ${RED}✗${RESET} $1"; }
dim() { echo -e "    ${DIM}$1${RESET}"; }
login_shell_path() {
  # Best-effort: capture the PATH a real login shell would see. This script runs
  # under `curl | bash`, a non-login shell whose PATH is the bare
  # /usr/bin:/bin:... — so dirs that ARE on the user's interactive PATH otherwise
  # look missing.
  local shell_bin="${SHELL:-}"
  [ -n "$shell_bin" ] || return 0
  case "$(basename "$shell_bin")" in
    bash | zsh | sh)
      "$shell_bin" -lic 'printf "%s" "$PATH"' 2>/dev/null || true
      ;;
    fish)
      "$shell_bin" -lic 'string join : $PATH' 2>/dev/null || true
      ;;
  esac
}
path_contains() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
  esac
  # Newlines (rc-file noise) are flattened to ':' so any real PATH segment still
  # matches while noise tokens stay isolated and harmless.
  case ":${LOGIN_PATH:-}:" in
    *":$1:"*) return 0 ;;
  esac
  return 1
}
can_install_to_dir() {
  local dir="$1"
  local parent="$dir"

  while [ ! -e "$parent" ]; do
    parent="$(dirname "$parent")"
  done

  [ -d "$dir" ] && [ -w "$dir" ] && return 0
  [ ! -e "$dir" ] && [ -w "$parent" ] && return 0
  return 1
}
# User-owned default, matching Codex/uv/Claude: never silently sudo into
# /usr/local/bin. Override with XMATRIX_INSTALL_DIR.
default_install_dir() {
  printf "%s/.local/bin" "$HOME"
}
pick_profile() {
  local os shell_name
  os="$(uname -s)"
  shell_name="$(basename "${SHELL:-}")"
  case "$os:$shell_name" in
    Darwin:zsh) printf "%s\n" "$HOME/.zprofile" ;;
    Darwin:bash) printf "%s\n" "$HOME/.bash_profile" ;;
    Linux:zsh) printf "%s\n" "$HOME/.zshrc" ;;
    Linux:bash) printf "%s\n" "$HOME/.bashrc" ;;
    *:fish)
      mkdir -p "$HOME/.config/fish"
      printf "%s\n" "$HOME/.config/fish/config.fish"
      ;;
    *) printf "%s\n" "$HOME/.profile" ;;
  esac
}
path_line_for_profile() {
  local profile="$1"
  case "$profile" in
    *.fish) printf "fish_add_path '%s'\n" "$INSTALL_DIR" ;;
    *) printf "export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR" ;;
  esac
}
append_path_block() {
  local profile="$1"
  local begin_marker="$2"
  local end_marker="$3"
  local path_line="$4"

  {
    printf "\n%s\n" "$begin_marker"
    printf "%s\n" "$path_line"
    printf "%s\n" "$end_marker"
  } >>"$profile"
}
rewrite_path_block() {
  local profile="$1"
  local begin_marker="$2"
  local end_marker="$3"
  local path_line="$4"
  local tmp in_block replaced line
  tmp="$(mktemp)"
  in_block=0
  replaced=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$begin_marker" ]; then
      in_block=1
      printf "%s\n" "$line" >>"$tmp"
      continue
    fi
    if [ "$in_block" -eq 1 ] && [ "$line" = "$end_marker" ]; then
      if [ "$replaced" -eq 0 ]; then
        printf "%s\n" "$path_line" >>"$tmp"
        replaced=1
      fi
      in_block=0
      printf "%s\n" "$line" >>"$tmp"
      continue
    fi
    if [ "$in_block" -eq 1 ]; then
      if [ "$replaced" -eq 0 ]; then
        printf "%s\n" "$path_line" >>"$tmp"
        replaced=1
      fi
      continue
    fi
    printf "%s\n" "$line" >>"$tmp"
  done <"$profile"
  mv "$tmp" "$profile"
}
add_to_path() {
  PATH_ACTION="already"
  PATH_PROFILE=""

  if path_contains "$INSTALL_DIR" && [ -z "${CONFLICT_PATH:-}" ]; then
    return 0
  fi

  local profile begin_marker end_marker path_line
  profile="$(pick_profile)"
  PATH_PROFILE="$profile"
  begin_marker="# >>> xMatrix installer >>>"
  end_marker="# <<< xMatrix installer <<<"
  path_line="$(path_line_for_profile "$profile")"
  path_line="${path_line%$'\n'}"

  if [ -f "$profile" ] && grep -F "$begin_marker" "$profile" >/dev/null 2>&1; then
    if grep -F "$path_line" "$profile" >/dev/null 2>&1; then
      PATH_ACTION="configured"
      return 0
    fi
    if grep -F "$end_marker" "$profile" >/dev/null 2>&1; then
      rewrite_path_block "$profile" "$begin_marker" "$end_marker" "$path_line"
      PATH_ACTION="updated"
      return 0
    fi
  fi

  touch "$profile"
  append_path_block "$profile" "$begin_marker" "$end_marker" "$path_line"
  PATH_ACTION="added"
}
print_path_result() {
  case "$PATH_ACTION" in
    added)
      info "PATH was added to ${BOLD}$PATH_PROFILE${RESET}"
      dim "Current terminal: export PATH=\"$INSTALL_DIR:\$PATH\""
      dim "Future terminals: open a new terminal"
      ;;
    updated)
      info "PATH was updated in ${BOLD}$PATH_PROFILE${RESET}"
      dim "Current terminal: export PATH=\"$INSTALL_DIR:\$PATH\""
      dim "Future terminals: open a new terminal"
      ;;
    configured)
      info "PATH is already configured in ${BOLD}$PATH_PROFILE${RESET}"
      dim "Current terminal: export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac
}
lookup_existing_xmatrix() {
  local candidate
  candidate="$(command -v "$BIN_NAME" 2>/dev/null || true)"
  if [ -n "$candidate" ]; then
    printf "%s\n" "$candidate"
    return 0
  fi
  for candidate in \
    "/opt/homebrew/bin/$BIN_NAME" \
    "/usr/local/bin/$BIN_NAME" \
    "$HOME/.cargo/bin/$BIN_NAME"
  do
    if [ -x "$candidate" ]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done
  return 1
}
detect_conflicting_install() {
  local existing installed
  installed="$INSTALL_DIR/$BIN_NAME"
  existing="$(lookup_existing_xmatrix || true)"
  if [ -z "$existing" ] || [ "$existing" = "$installed" ]; then
    CONFLICT_PATH=""
    return 0
  fi
  CONFLICT_PATH="$existing"
  info "Detected existing ${BOLD}$BIN_NAME${RESET} at ${BOLD}$existing${RESET}"
  dim "The installer is placing a user-owned copy at $installed."
  dim "PATH order decides which one runs; put $INSTALL_DIR first, or remove the older copy."
}
# `[ -r /dev/tty ]` is not an interactivity test: in a cron job, CI runner, or
# any other session without a controlling terminal the device node is still
# readable by permission while opening it fails with ENXIO. Only an actual open
# answers the question.
has_controlling_tty() {
  { : < /dev/tty; } 2>/dev/null
}
# The daemon is what makes this machine reachable from chat, so it is part of
# the install rather than a choice. The only reason to skip it is a platform
# this installer cannot set up.
daemon_setup_supported() {
  case "$OS_NAME" in
    macos|linux) return 0 ;;
    *)
      info "Daemon startup is not supported for $OS_NAME by this installer"
      return 1
      ;;
  esac
}
# The launchd plist and systemd unit are generated by the binary itself
# (`xmatrix setup daemon`), so the Desktop App's bundled seed and this script
# register the daemon the same way.
install_daemon_autostart_macos() {
  local bin_path="$1"
  "$bin_path" setup daemon --binary "$bin_path"
}
install_daemon_autostart_linux() {
  local bin_path="$1"
  if ! command -v systemctl >/dev/null 2>&1; then
    error "systemctl is required to install the xMatrix daemon service"
    return 1
  fi
  "$bin_path" setup daemon --binary "$bin_path"
}
setup_daemon() {
  local bin_path="$1"

  if ! daemon_setup_supported; then
    return 0
  fi

  # Re-running the installer must not force a second browser round trip, and a
  # non-interactive install must not block on one. Without a session the daemon
  # still installs; the next `xmatrix login` hands it the credentials.
  if "$bin_path" whoami >/dev/null 2>&1; then
    info "Using the existing xMatrix login"
  elif has_controlling_tty; then
    info "Browser sign-in is required before starting the daemon"
    XMATRIX_SKIP_DAEMON_AUTOSTART=1 "$bin_path" login
  else
    info "No interactive terminal for sign-in; run 'xmatrix login' to finish setup"
  fi

  step "Installing daemon startup entry..."
  case "$OS_NAME" in
    macos) install_daemon_autostart_macos "$bin_path" ;;
    linux) install_daemon_autostart_linux "$bin_path" ;;
    *) error "Daemon startup is not supported for $OS_NAME by this installer"; return 1 ;;
  esac
  mark_done 1
  success "xMatrix daemon will start at login and is running now"
}
mark_done() {
  local n="${1:-1}"
  printf "\033[${n}A\r  ${GREEN}✓${RESET}\033[${n}B\r"
}
header() {
  echo ""
  echo -e "  ${BOLD}${CYAN}xMatrix${RESET} ${DIM}CLI Installer${RESET}"
  echo -e "  ${DIM}-------------------------${RESET}"
  echo ""
}

header

LOGIN_PATH="$(login_shell_path | tr '\n' ':')"

BIN_NAME="${XMATRIX_BIN_NAME:-xmatrix}"
INSTALL_DIR="${XMATRIX_INSTALL_DIR:-$(default_install_dir)}"
PATH_ACTION="already"
PATH_PROFILE=""
CONFLICT_PATH=""
RELEASE_API_URL="${XMATRIX_RELEASE_API_URL:-https://xmatrix.sh/api/cli/releases/latest}"

_curl() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -H "Authorization: token $GITHUB_TOKEN" "$@"
  else
    curl "$@"
  fi
}

# A real JSON parser is required; never infer a digest from another asset.
release_asset_metadata() {
  local name="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
assets=[a for a in json.load(sys.stdin)["assets"] if a.get("name")==sys.argv[1]]
if len(assets)!=1: raise ValueError("Expected exactly one release asset")
a=assets[0]
print(str(a.get("browser_download_url",""))+"\t"+str(a.get("sha256",""))+"\t"+str(a.get("size","")))' "$name"
  elif command -v node >/dev/null 2>&1; then
    node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")).assets.filter(a=>a.name===process.argv[1]); if(a.length!==1)process.exit(1); console.log([a[0].browser_download_url,a[0].sha256,a[0].size].join("\t"));' "$name"
  elif command -v jq >/dev/null 2>&1; then
    jq -er --arg name "$name" '[.assets[] | select(.name == $name)] | if length == 1 then .[0] | [.browser_download_url,.sha256,.size] | @tsv else error("Expected exactly one release asset") end'
  else
    printf '%s\n' 'Install Python 3, Node.js or jq to verify release metadata.' >&2
    return 1
  fi
}

verify_release_asset() {
  local file="$1" expected="$2" size="$3" actual
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || return 1
  [[ "$size" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$(wc -c < "$file" | tr -d '[:space:]')" = "$size" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    printf '%s\n' 'A SHA-256 tool (sha256sum or shasum) is required.' >&2
    return 1
  fi
  [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ]
}

curl_json() { _curl -fsSL "$1"; }

curl_file() {
  local url="$1" output="$2"

  # Resolve content length (follow redirects, best-effort)
  local total
  total=$(_curl -fsSLI "$url" 2>/dev/null \
    | grep -i '^content-length:' | tail -1 | tr -dc '0-9') || true

  # Start download in background
  _curl -fsSL "$url" -o "$output" &
  local pid=$!

  local w=30
  if [ -n "${total:-}" ] && [ "${total:-0}" -gt 0 ] 2>/dev/null; then
    # ── Progress bar mode ──
    local cur=0 pct=0 f=0 e=0 filled="" empty="" mb="" bar_full="" total_mb=""
    while kill -0 "$pid" 2>/dev/null; do
      if [ -f "$output" ]; then
        cur=$(wc -c < "$output" 2>/dev/null | tr -d ' ') || true
        cur=${cur:-0}
        [ "$cur" -gt "$total" ] && cur=$total
        pct=$((cur * 100 / total))
        [ "$pct" -gt 100 ] && pct=100
        f=$((pct * w / 100))
        e=$((w - f))
        filled="" empty=""
        [ "$f" -gt 0 ] && filled=$(printf '%*s' "$f" '' | tr ' ' '━')
        [ "$e" -gt 0 ] && empty=$(printf '%*s' "$e" '' | tr ' ' '─')
        mb=$(awk "BEGIN{printf \"%.1f/%.1f MB\", ${cur}/1048576, ${total}/1048576}" 2>/dev/null) || mb=""
        printf "\r    \033[36m%s\033[0m\033[2m%s %3d%%" "$filled" "$empty" "$pct"
        [ -n "$mb" ] && printf "  %s" "$mb"
        printf "\033[K\033[0m"
      fi
      sleep 0.1
    done
    # Final 100%
    bar_full=$(printf '%*s' "$w" '' | tr ' ' '━')
    total_mb=$(awk "BEGIN{printf \"%.1f MB\", ${total}/1048576}" 2>/dev/null) || total_mb=""
    printf "\r    \033[36m%s\033[0m\033[2m 100%%" "$bar_full"
    [ -n "$total_mb" ] && printf "  %s" "$total_mb"
    printf "\033[K\033[0m\n"
  else
    # ── Spinner fallback ──
    local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 cur=0 mb="" fc=0 final_mb=""
    while kill -0 "$pid" 2>/dev/null; do
      if [ -f "$output" ]; then
        cur=$(wc -c < "$output" 2>/dev/null | tr -d ' ') || true
        mb=$(awk "BEGIN{printf \"%.1f\", ${cur:-0}/1048576}" 2>/dev/null) || mb="?"
        printf "\r    \033[2m${spin:$i:1} %s MB downloaded\033[K\033[0m" "$mb"
      else
        printf "\r    \033[2m${spin:$i:1} starting...\033[K\033[0m"
      fi
      i=$(( (i + 1) % ${#spin} ))
      sleep 0.08
    done
    if [ -f "$output" ]; then
      fc=$(wc -c < "$output" 2>/dev/null | tr -d ' ') || true
      final_mb=$(awk "BEGIN{printf \"%.1f\", ${fc:-0}/1048576}" 2>/dev/null) || final_mb="?"
      printf "\r    \033[2m✓ %s MB downloaded\033[K\033[0m\n" "$final_mb"
    else
      printf "\r    \033[2m✓ downloaded\033[K\033[0m\n"
    fi
  fi

  wait "$pid"
}

OS="$(uname -s)"
case "$OS" in
  Linux*) OS_NAME="linux" ;;
  Darwin*) OS_NAME="macos" ;;
  MINGW*|MSYS*|CYGWIN*) OS_NAME="windows" ;;
  *) error "Unsupported OS: ${BOLD}$OS${RESET}"; exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) error "Unsupported architecture: ${BOLD}$ARCH${RESET}"; exit 1 ;;
esac

EXE=""
if [ "$OS_NAME" = "windows" ]; then
  EXE=".exe"
fi

ASSET_NAME="${BIN_NAME}-${OS_NAME}-${ARCH_NAME}${EXE}"
info "Found environment: ${BOLD}${OS_NAME}-${ARCH_NAME}${RESET}"
info "Install location: ${BOLD}$INSTALL_DIR${RESET}"

if ! can_install_to_dir "$INSTALL_DIR"; then
  error "Cannot write to ${BOLD}$INSTALL_DIR${RESET}"
  dim "This installer never uses sudo. Leave XMATRIX_INSTALL_DIR unset to install to $HOME/.local/bin, or point it at a directory you own."
  exit 1
fi
detect_conflicting_install

step "Fetching release metadata..."
if ! RELEASE_JSON="$(curl_json "$RELEASE_API_URL")"; then
  error "Could not fetch release metadata"
  dim "Checked: $RELEASE_API_URL"
  exit 1
fi
mark_done 1

if ! ASSET_METADATA="$(printf '%s' "$RELEASE_JSON" | release_asset_metadata "$ASSET_NAME")"; then
  error "Could not parse unique release asset metadata"
  exit 1
fi
IFS=$'\t' read -r DOWNLOAD_URL EXPECTED_SHA256 EXPECTED_SIZE <<< "$ASSET_METADATA"
if [[ ! "$DOWNLOAD_URL" =~ ^https://[^[:space:]]+$ ]] || [[ ! "$EXPECTED_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || [[ ! "$EXPECTED_SIZE" =~ ^[1-9][0-9]*$ ]]; then
  error "Release asset requires an HTTPS URL, SHA-256 and positive size"
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

INSTALLED_BIN="${BIN_NAME}${EXE}"

step "Downloading binary..."
dim "URL: $DOWNLOAD_URL"
if ! curl_file "$DOWNLOAD_URL" "$TEMP_DIR/$INSTALLED_BIN"; then
  error "Failed to download release asset"
  exit 1
fi
if ! verify_release_asset "$TEMP_DIR/$INSTALLED_BIN" "$EXPECTED_SHA256" "$EXPECTED_SIZE"; then
  error "Release asset integrity check failed; nothing was executed"
  exit 1
fi
chmod +x "$TEMP_DIR/$INSTALLED_BIN"
mark_done 3

step "Validating downloaded binary..."
if ! "$TEMP_DIR/$INSTALLED_BIN" --help >/dev/null 2>&1; then
  error "Downloaded release asset failed to start"
  exit 1
fi
mark_done 1

step "Installing to ${BOLD}$INSTALL_DIR${RESET}..."
mkdir -p "$INSTALL_DIR"
mv "$TEMP_DIR/$INSTALLED_BIN" "$INSTALL_DIR/$INSTALLED_BIN"
mark_done 1

VERSION=$("$INSTALL_DIR/$INSTALLED_BIN" --version 2>/dev/null | awk '{print $NF}')
echo ""
if [ -n "$VERSION" ]; then
  success "Installed ${BOLD}${BIN_NAME}@${VERSION}${RESET} successfully!"
else
  success "Installed ${BOLD}${BIN_NAME}${RESET} successfully!"
fi

dim "Location: $INSTALL_DIR/$INSTALLED_BIN"
echo ""
add_to_path
print_path_result
setup_daemon "$INSTALL_DIR/$INSTALLED_BIN"
info "Run ${BOLD}${GREEN}$BIN_NAME --help${RESET} to get started"
echo ""
