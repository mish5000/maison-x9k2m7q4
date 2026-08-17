#!/usr/bin/env bash
# Install and configure agent-browser (https://github.com/vercel-labs/agent-browser)
# for use inside a Claude Code sandbox.
#
# Beyond `npm i -g agent-browser && agent-browser install`, two sandbox-specific
# fixes are needed before the browser can reach the internet:
#
#   1. Trust the egress gateway CA. Outbound HTTPS is intercepted for some hosts,
#      and Chrome does not read the system trust store on Linux — it reads NSS.
#      The sandbox pre-creates an empty NSS db, so the CAs from
#      /root/.ccr/ca-bundle.crt have to be imported with certutil.
#   2. Disable ECH. Chrome sends a GREASE Encrypted-Client-Hello extension on
#      every handshake; the egress gateway resets any connection carrying it
#      (verified by replaying ClientHellos with and without ext 0xfe0d). Chrome
#      has no runtime flag for this, only the `ssl.ech_enabled` local-state pref,
#      which requires a persistent profile directory.
#
# Idempotent — safe to re-run.
set -euo pipefail

AB_HOME="${HOME}/.agent-browser"
PROFILE_DIR="${AB_HOME}/profile"
CCR_BUNDLE="/root/.ccr/ca-bundle.crt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Installing agent-browser CLI"
npm install -g agent-browser
agent-browser install

if [[ -r "$CCR_BUNDLE" ]]; then
  echo "==> Importing sandbox egress CAs into Chrome's NSS trust stores"

  certutil_bin="$(command -v certutil || true)"
  if [[ -z "$certutil_bin" ]]; then
    # certutil ships in libnss3-tools; unpack it locally rather than installing.
    ( cd "$WORK" && apt-get download libnss3-tools >/dev/null )
    dpkg-deb -x "$WORK"/libnss3-tools_*.deb "$WORK/nss"
    certutil_bin="$WORK/nss/usr/bin/certutil"
  fi

  # Split the bundle into the Anthropic-issued CAs (the interception roots).
  python3 - "$CCR_BUNDLE" "$WORK" <<'PY'
import re, subprocess, sys
bundle, work = sys.argv[1], sys.argv[2]
pem = open(bundle).read()
n = 0
for cert in re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----\n?', pem, re.S):
    subject = subprocess.run(['openssl', 'x509', '-noout', '-subject'],
                             input=cert.encode(), capture_output=True).stdout.decode()
    if 'Anthropic' in subject:
        open(f'{work}/egress-ca-{n}.pem', 'w').write(cert)
        n += 1
print(f'    found {n} Anthropic CA(s) in the bundle')
PY

  # Chrome looks for the user NSS db in both of these locations depending on build.
  for db in "${HOME}/.pki/nssdb" "${HOME}/.local/share/pki/nssdb"; do
    mkdir -p "$db"
    for cert in "$WORK"/egress-ca-*.pem; do
      name="ccr-egress-$(basename "$cert" .pem)"
      "$certutil_bin" -d "sql:$db" -A -t "C,," -n "$name" -i "$cert" 2>/dev/null || true
    done
    echo "    imported into $db"
  done
else
  echo "==> No ${CCR_BUNDLE}; skipping CA import (not in a proxied sandbox)"
fi

echo "==> Configuring a persistent profile with ECH disabled"
mkdir -p "$PROFILE_DIR"
if [[ -f "${PROFILE_DIR}/Local State" ]]; then
  python3 - "${PROFILE_DIR}/Local State" <<'PY'
import json, sys
p = sys.argv[1]
state = json.load(open(p))
state.setdefault('ssl', {})['ech_enabled'] = False
json.dump(state, open(p, 'w'))
PY
else
  printf '{"ssl":{"ech_enabled":false}}' > "${PROFILE_DIR}/Local State"
fi

# Make that profile the default for every agent-browser invocation.
python3 - "${AB_HOME}/config.json" "$PROFILE_DIR" <<'PY'
import json, os, sys
path, profile = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(path):
    try:
        cfg = json.load(open(path))
    except ValueError:
        cfg = {}
cfg['profile'] = profile
json.dump(cfg, open(path, 'w'), indent=2)
PY

echo "==> Verifying"
agent-browser close --all >/dev/null 2>&1 || true
agent-browser open https://example.com
agent-browser get title
echo "==> Done. Try: agent-browser open <url> && agent-browser snapshot -i"
