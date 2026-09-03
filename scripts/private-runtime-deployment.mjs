const WRAPPER = `#!/bin/sh
set -eu
[ "$#" -eq 2 ] || exit 64
action="$1"
session="$2"

case "$action" in
  start|stop|settle) ;;
  *) exit 64 ;;
esac

/usr/bin/printf '%s\\n' "$session" | /usr/bin/grep -Eq '^uat-[0-9]+-[0-9a-f]{8}$' || exit 64

case "$action" in
  start) exec /usr/bin/systemctl start "villa-engine-uat@\${session}.service" ;;
  stop) exec /usr/bin/systemctl stop "villa-engine-uat@\${session}.service" ;;
  settle) exec /usr/bin/systemctl start "villa-engine-uat-settle@\${session}.service" ;;
esac
`;

const SESSION_UNIT = `[Unit]
Description=VILLA account-bound private UAT session %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=villa-engine
Group=villa-engine
WorkingDirectory=/opt/villa-private-runtime
ExecStart=/usr/bin/node /opt/villa-private-runtime/scripts/lp-account-session-service.mjs
Environment=VILLA_ENGINE_OWNER=0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d
Environment=VILLA_ENGINE_ACCOUNT=0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2
Environment=VILLA_ENGINE_OPERATOR=0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37
Environment=VILLA_ENGINE_SESSION_ID=%i
Environment=VILLA_UAT_SESSION_EXECUTION=true
Environment=VILLA_UAT_SETTLEMENT_EXECUTION=false
Environment=VILLA_EXECUTION_ENABLED=true
Environment=VILLA_EXECUTION_MODE=WET
Environment=VILLA_UAT_STATUS_FILE=/run/villa-uat-status/%i.json
Environment=VILLA_UAT_PRIVATE_STATE_FILE=/var/lib/villa-engine/uat-%i/session.json
Environment=VILLA_LEASE_DIR=/var/lib/villa-engine/uat-%i
Environment=VILLA_STATE_DIR=/var/lib/villa-engine/uat-%i
Environment=VILLA_WRITER_JOURNAL=/var/lib/villa-engine/uat-%i/transactions.json
LoadCredential=operator-key:/etc/villa-engine.env
StateDirectory=villa-engine/uat-%i
UMask=0077
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=180
SendSIGKILL=no
Restart=no
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictNamespaces=true
MemoryDenyWriteExecute=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/run/villa-uat-status /var/lib/villa-engine

[Install]
WantedBy=multi-user.target
`;

const SETTLEMENT_UNIT = `[Unit]
Description=VILLA account-bound private UAT settlement %i
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=villa-engine
Group=villa-engine
WorkingDirectory=/opt/villa-private-runtime
ExecStart=/usr/bin/node /opt/villa-private-runtime/scripts/lp-account-settlement.mjs
Environment=VILLA_ENGINE_OWNER=0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d
Environment=VILLA_ENGINE_ACCOUNT=0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2
Environment=VILLA_ENGINE_OPERATOR=0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37
Environment=VILLA_ENGINE_SESSION_ID=%i
Environment=VILLA_UAT_SESSION_EXECUTION=false
Environment=VILLA_UAT_SETTLEMENT_EXECUTION=true
Environment=VILLA_EXECUTION_ENABLED=true
Environment=VILLA_EXECUTION_MODE=WET
Environment=VILLA_UAT_STATUS_FILE=/run/villa-uat-status/%i.json
Environment=VILLA_UAT_PRIVATE_STATE_FILE=/var/lib/villa-engine/uat-%i/session.json
Environment=VILLA_LEASE_DIR=/var/lib/villa-engine/uat-%i
Environment=VILLA_STATE_DIR=/var/lib/villa-engine/uat-%i
Environment=VILLA_WRITER_JOURNAL=/var/lib/villa-engine/uat-%i/transactions.json
LoadCredential=operator-key:/etc/villa-engine.env
StateDirectory=villa-engine/uat-%i
UMask=0077
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=180
SendSIGKILL=no
Restart=no
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictNamespaces=true
MemoryDenyWriteExecute=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/run/villa-uat-status /var/lib/villa-engine
`;

export const PRIVATE_RUNTIME_ROOT = "/opt/villa-private-runtime";
export const PRIVATE_STATE_ROOT = "/var/lib/villa-engine";
export const STATUS_ROOT = "/run/villa-uat-status";

export const PRIVATE_DEPLOYMENT_FILES = Object.freeze({
  "usr/local/libexec/villa-uat-control": WRAPPER,
  "etc/systemd/system/villa-engine-uat@.service": SESSION_UNIT,
  "etc/systemd/system/villa-engine-uat-settle@.service": SETTLEMENT_UNIT,
  "etc/tmpfiles.d/villa-uat.conf": "d /run/villa-uat-status 2750 villa-engine villa -\n",
  "etc/sudoers.d/villa-uat-control": "Cmnd_Alias VILLA_UAT_CONTROL = /usr/local/libexec/villa-uat-control\nvilla ALL=(root) NOPASSWD: VILLA_UAT_CONTROL\nDefaults!VILLA_UAT_CONTROL !setenv\n",
});

export const PRIVATE_DEPLOYMENT_MODES = Object.freeze({
  "usr/local/libexec/villa-uat-control": 0o755,
  "etc/systemd/system/villa-engine-uat@.service": 0o644,
  "etc/systemd/system/villa-engine-uat-settle@.service": 0o644,
  "etc/tmpfiles.d/villa-uat.conf": 0o644,
  "etc/sudoers.d/villa-uat-control": 0o440,
});

export const PRIVATE_RUNTIME_ENTRIES = Object.freeze([
  "scripts/lp-account-session-service.mjs",
  "scripts/lp-account-session.mjs",
  "scripts/lp-account-settlement.mjs",
]);
