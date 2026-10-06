# Prepare the existing isolated keychain; callers retain their own cleanup and
# identity refusal messages. Only this keychain is added to the search list.
prepare_developer_id_keychain() {
  local certificate="$1" intermediate="$2" keychain="$3" keychain_password="$4"
  local encoded_certificate expected_intermediate_sha256 actual_intermediate_sha256
  case "$CSC_LINK" in
    https://*|http://*)
      curl --fail --show-error --location \
        --retry 5 --retry-all-errors --connect-timeout 15 --max-time 180 \
        "$CSC_LINK" -o "$certificate"
      ;;
    file://*)
      cp "${CSC_LINK#file://}" "$certificate"
      ;;
    *)
      encoded_certificate="${CSC_LINK#data:*;base64,}"
      printf '%s' "$encoded_certificate" | /usr/bin/base64 -D > "$certificate"
      ;;
  esac

  expected_intermediate_sha256="f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a"
  curl --fail --show-error --location \
    --retry 5 --retry-all-errors --connect-timeout 15 --max-time 180 \
    "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer" \
    -o "$intermediate"
  actual_intermediate_sha256="$(shasum -a 256 "$intermediate" | awk '{print $1}')"
  if [ "$actual_intermediate_sha256" != "$expected_intermediate_sha256" ]; then
    echo "Unexpected Apple Developer ID G2 certificate checksum: $actual_intermediate_sha256" >&2
    exit 1
  fi

  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  # `security set-key-partition-list` resolves an imported identity
  # through the user search list even when a keychain path is passed.
  # Keep the ephemeral signing keychain first while signing, then
  # remove only this job's keychain in the EXIT trap so concurrent
  # self-hosted release jobs cannot have their search entries lost.
  scripts/macos-keychain-search-list.sh add "$keychain"
  security import "$intermediate" -k "$keychain" -T /usr/bin/codesign
  security import "$certificate" -k "$keychain" -P "${CSC_KEY_PASSWORD:-}" -T /usr/bin/codesign
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain"

  identity="$(security find-identity -v -p codesigning "$keychain" | \
    awk -v team="$MACOS_RELEASE_TEAM_ID" \
      '$0 ~ /Developer ID Application:/ && index($0, "(" team ")") { print $2; exit }')"
}
