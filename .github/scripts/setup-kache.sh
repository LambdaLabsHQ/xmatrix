#!/usr/bin/env bash
# Install kache (https://github.com/kunobi-ninja/kache) and wire it up as
# RUSTC_WRAPPER. Mirrors accelerator's setup-local-kache composite action —
# same install dir and cache dir, so the binary and the local cache store are
# shared machine-wide across every repo served by this org-level self-hosted
# runner. Cargo keeps the default in-package target dir (packages/cli-rs/target)
# so concurrent jobs and worktrees stay isolated; do not redirect CARGO_TARGET_DIR.
set -euo pipefail

version="${KACHE_VERSION:-0.10.0}"
system="$(uname -s)"
machine="$(uname -m)"
is_windows=false
asset_suffix=".tar.gz"
binary_name="kache"

case "${system}" in
  MINGW* | MSYS* | CYGWIN*)
    # Git for Windows can report the architecture of its own Unix layer (for
    # example MINGW32/i686) even when Cargo targets 64-bit MSVC. Select the
    # native kache binary from rustc's host instead of the Bash process.
    rust_host="$(rustc -vV | sed -n 's/^host: //p')"
    case "${rust_host}" in
      x86_64-pc-windows-msvc | aarch64-pc-windows-msvc)
        target="${rust_host}"
        ;;
      *)
        echo "kache has no release for Windows rustc host ${rust_host:-unknown} (${system}-${machine})" >&2
        exit 1
        ;;
    esac
    is_windows=true
    asset_suffix=".exe"
    binary_name="kache.exe"
    ;;
  *)
    case "${system}-${machine}" in
      Linux-x86_64)
        target="x86_64-unknown-linux-musl"
        ;;
      Linux-aarch64 | Linux-arm64)
        target="aarch64-unknown-linux-musl"
        ;;
      Darwin-x86_64)
        target="x86_64-apple-darwin"
        ;;
      Darwin-arm64)
        target="aarch64-apple-darwin"
        ;;
      *)
        echo "kache has no release for ${system}-${machine}; building without a compile cache"
        exit 0
        ;;
    esac
    ;;
esac

install_root="${HOME}/.local/accelerator-ci/kache"
install_dir="${install_root}/v${version}"
kache_bin="${install_dir}/${binary_name}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
kache_config="${repo_root}/scripts/kache.toml"
if [[ ! -f "${kache_config}" ]]; then
  echo "required kache configuration is missing: ${kache_config}" >&2
  exit 1
fi

if [[ ! -x "${kache_bin}" ]]; then
  tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  asset="${tmp_root}/kache-${target}${asset_suffix}"
  checksum="${asset}.sha256"
  extract_dir="${tmp_root}/kache-${target}"
  rm -rf "${asset}" "${checksum}" "${extract_dir}"
  mkdir -p "${install_dir}" "${extract_dir}"

  base_url="https://github.com/kunobi-ninja/kache/releases/download/v${version}"
  if ! curl -fsSL --http1.1 --retry 8 --retry-all-errors --retry-delay 2 "${base_url}/$(basename "${asset}")" -o "${asset}"; then
    echo "kache download failed; building without a compile cache" >&2
    exit 0
  fi
  if ! curl -fsSL --http1.1 --retry 8 --retry-all-errors --retry-delay 2 "${base_url}/$(basename "${checksum}")" -o "${checksum}"; then
    echo "kache checksum download failed; building without a compile cache" >&2
    exit 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "${tmp_root}" && sha256sum -c "$(basename "${checksum}")")
  else
    (cd "${tmp_root}" && shasum -a 256 -c "$(basename "${checksum}")")
  fi

  if [[ "${is_windows}" == "true" ]]; then
    install -m 0755 "${asset}" "${kache_bin}"
  else
    tar -xzf "${asset}" -C "${extract_dir}"
    found_bin="$(find "${extract_dir}" -type f -name kache -perm -u+x | head -n 1)"
    if [[ -z "${found_bin}" ]]; then
      echo "kache binary not found in release archive" >&2
      exit 1
    fi
    install -m 0755 "${found_bin}" "${kache_bin}"
  fi
fi

if [[ "${is_windows}" == "true" ]]; then
  if [[ -n "${KACHE_CACHE_DIR:-}" ]]; then
    cache_dir="$(cygpath -u "${KACHE_CACHE_DIR}")"
  else
    cache_dir="$(cygpath -u "${LOCALAPPDATA:-${HOME}/AppData/Local}")/kache"
  fi
else
  cache_dir="${KACHE_CACHE_DIR:-${HOME}/.cache/kache}"
fi
mkdir -p "${cache_dir}"

"${kache_bin}" --version || true
github_install_dir="${install_dir}"
github_kache_bin="${kache_bin}"
github_cache_dir="${cache_dir}"
github_kache_config="${kache_config}"
if [[ "${is_windows}" == "true" ]]; then
  github_install_dir="$(cygpath -m "${install_dir}")"
  github_kache_bin="$(cygpath -m "${kache_bin}")"
  github_cache_dir="$(cygpath -m "${cache_dir}")"
  github_kache_config="$(cygpath -m "${kache_config}")"
fi

echo "${github_install_dir}" >> "${GITHUB_PATH}"
{
  echo "RUSTC_WRAPPER=${github_kache_bin}"
  echo "KACHE_CACHE_DIR=${github_cache_dir}"
  echo "KACHE_CONFIG=${github_kache_config}"
  # Cache final bins / integration-test executables so cold worktrees and
  # Windows pre-commit do not re-link every cargo test binary from scratch.
  echo "KACHE_CACHE_EXECUTABLES=true"
} >> "${GITHUB_ENV}"
if [[ "${is_windows}" == "true" ]]; then
  echo "KACHE_WINDOWS_HARDLINK=true" >> "${GITHUB_ENV}"
fi
echo "kache enabled: wrapper=${github_kache_bin} cache=${github_cache_dir} config=${github_kache_config} cache_executables=true"
