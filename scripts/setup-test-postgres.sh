#!/usr/bin/env bash
# CI-only, unprivileged toolchain. Never installs a service or uses a database.
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'This bootstrap is Linux-only' >&2; exit 1; }
: "${RUNNER_TEMP:?RUNNER_TEMP must identify the job temporary directory}"
: "${GITHUB_ENV:?GITHUB_ENV is required for the following test step}"
postgres_apt_config="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/test-postgres-apt.conf"

postgres_version=17.11
postgres_sha256=5367f6fb2ec97efe1eb2e0c7926bb33438e51b0bd3a9733b88498056a7dc9a7e
postgres_configure_flags="--without-icu --without-readline --without-zlib"
# Self-hosted runners persist between jobs, so a finished build is kept in a
# host-local cache keyed by everything that shapes it. A hit skips the ~5 minute
# source build; a miss builds exactly as before and publishes atomically.
postgres_cache_root="${XMATRIX_TEST_POSTGRES_CACHE:-${HOME:?HOME is required for the test PostgreSQL cache}/.cache/xmatrix-test-postgres}"
postgres_cache_key="${postgres_version}-${postgres_sha256:0:16}-$(uname -m)-$(printf '%s' "$postgres_configure_flags" | sha256sum | cut -c1-12)"
postgres_cache_entry="$postgres_cache_root/$postgres_cache_key"
postgres_cache_usable() {
  [[ -f "$postgres_cache_entry/.complete" ]] || return 1
  for tool in initdb pg_ctl createdb psql; do
    "$postgres_cache_entry/bin/$tool" --version | grep -q " ${postgres_version}\$" || return 1
  done
}
if postgres_cache_usable; then
  echo "Using cached PostgreSQL test tools from $postgres_cache_entry"
  printf 'XMATRIX_TEST_POSTGRES_BIN=%s/bin\n' "$postgres_cache_entry" >> "$GITHUB_ENV"
  exit 0
fi

postgres_build=$(mktemp -d "${RUNNER_TEMP%/}/xmatrix-test-postgres.XXXXXXXX")
echo "Building isolated PostgreSQL test tools in $postgres_build"
# Retain this exact job-owned directory on failure for diagnostics. Actions owns
# its eventual cleanup; this script has no recursive deletion or system writes.
cd "$postgres_build"

# Minimal runner images need parser generators and an archive decompressor. Download distro-verified
# packages without sudo, apt install, package scripts, or a system service.
if ! command -v bison >/dev/null || ! command -v flex >/dev/null || ! command -v m4 >/dev/null || ! command -v make >/dev/null || ! command -v gzip >/dev/null; then
  mkdir -p parser-tools/apt-lists/partial parser-tools/apt-cache/archives/partial
  # Some container runners omit all package lists. Refresh into job-owned paths
  # using the host's repository/key definitions, without host apt.conf hooks or
  # writes to /var/lib/apt and /var/cache/apt. Signature verification stays on.
  apt_options=(
    -o "Dir::State::lists=$postgres_build/parser-tools/apt-lists"
    -o "Dir::Cache=$postgres_build/parser-tools/apt-cache"
    -o "APT::Get::List-Cleanup=0"
  )
  APT_CONFIG="$postgres_apt_config" apt-get "${apt_options[@]}" update
  (cd parser-tools && APT_CONFIG="$postgres_apt_config" apt-get "${apt_options[@]}" download bison flex m4 make gzip)
  for archive in parser-tools/*.deb; do
    dpkg-deb --extract "$archive" "$postgres_build/parser-tools/root"
  done
  export PATH="$postgres_build/parser-tools/root/usr/bin:$PATH"
  export BISON_PKGDATADIR="$postgres_build/parser-tools/root/usr/share/bison"
  export M4="$postgres_build/parser-tools/root/usr/bin/m4"
fi
for tool in cc make bison flex m4 gzip curl tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "Required build tool missing: $tool" >&2; exit 1; }
done
gzip --version >/dev/null
curl --fail --location --silent --show-error --retry 3 --max-time 180 \
  "https://ftp.postgresql.org/pub/source/v${postgres_version}/postgresql-${postgres_version}.tar.gz" \
  --output source.tar.gz
printf '%s  source.tar.gz\n' "$postgres_sha256" | sha256sum --check --strict
tar --extract --gzip --file source.tar.gz
cd "postgresql-${postgres_version}"
# The prefix is the final cache path because the binaries embed it (rpath,
# share/lib lookup); DESTDIR stages the install on the cache's filesystem so the
# publish below is a single rename.
mkdir -p "$postgres_cache_root"
postgres_stage=$(mktemp -d "$postgres_cache_root/.stage.XXXXXXXX")
# shellcheck disable=SC2086 # the flags are a fixed word list
./configure --prefix="$postgres_cache_entry" $postgres_configure_flags
make -j"$(nproc 2>/dev/null || echo 2)"
make install DESTDIR="$postgres_stage"
printf '%s\n' "$postgres_cache_key" > "$postgres_stage$postgres_cache_entry/.complete"
# A concurrent job may publish the same key first; its build is equivalent, and
# mv -T refuses to nest into an existing entry instead of overwriting it.
mv -T "$postgres_stage$postgres_cache_entry" "$postgres_cache_entry" 2>/dev/null ||
  echo "Another job published $postgres_cache_key first; using it"
postgres_cache_usable || { echo "Cached PostgreSQL test tools failed verification" >&2; exit 1; }
for tool in initdb pg_ctl createdb psql; do
  "$postgres_cache_entry/bin/$tool" --version
done
printf 'XMATRIX_TEST_POSTGRES_BIN=%s/bin\n' "$postgres_cache_entry" >> "$GITHUB_ENV"
