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
ConditionPathExists=/run/villa-uat-bindings/%i.env

[Service]
Type=simple
User=villa-engine
Group=villa-engine
WorkingDirectory=/opt/villa-private-runtime
ExecStart=/usr/bin/node --jitless /opt/villa-private-runtime/scripts/lp-account-session-service.mjs
EnvironmentFile=/run/villa-uat-bindings/%i.env
Environment=VILLA_ENGINE_OPERATOR=0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37
Environment=VILLA_ENGINE_SESSION_ID=%i
Environment=VILLA_UAT_SESSION_EXECUTION=true
Environment=VILLA_UAT_SETTLEMENT_EXECUTION=false
Environment=VILLA_EXECUTION_ENABLED=false
Environment=VILLA_ACCOUNT_EXECUTION_ENABLED=true
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
ConditionPathExists=/run/villa-uat-bindings/%i.env

[Service]
Type=oneshot
User=villa-engine
Group=villa-engine
WorkingDirectory=/opt/villa-private-runtime
ExecStart=/usr/bin/node --jitless /opt/villa-private-runtime/scripts/lp-account-settlement.mjs
EnvironmentFile=/run/villa-uat-bindings/%i.env
Environment=VILLA_ENGINE_OPERATOR=0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37
Environment=VILLA_ENGINE_SESSION_ID=%i
Environment=VILLA_UAT_SESSION_EXECUTION=false
Environment=VILLA_UAT_SETTLEMENT_EXECUTION=true
Environment=VILLA_EXECUTION_ENABLED=false
Environment=VILLA_ACCOUNT_EXECUTION_ENABLED=true
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

const BROKER_UNIT = `[Unit]
Description=VILLA root account-session broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=villa
WorkingDirectory=/opt/villa-private-runtime
ExecStart=/usr/bin/node /opt/villa-private-runtime/scripts/villa-uat-broker.mjs
Environment=VILLA_UAT_BROKER_SOCKET=/run/villa-uat-broker/control.sock
Environment=VILLA_ENGINE_OPERATOR=0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37
UnsetEnvironment=OPERATOR_PRIVATE_KEY TAKER_PRIVATE_KEY PRIVATE_KEY WALLET_SEED MNEMONIC CREDENTIALS_DIRECTORY
UMask=0007
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
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID CAP_KILL
AmbientCapabilities=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID CAP_KILL
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
InaccessiblePaths=/etc/villa-engine.env
ReadWritePaths=/run/villa-uat-broker /run/villa-uat-bindings
Restart=no

[Install]
WantedBy=multi-user.target
`;

export const PRIVATE_RUNTIME_ROOT = "/opt/villa-private-runtime";
export const PRIVATE_STATE_ROOT = "/var/lib/villa-engine";
export const STATUS_ROOT = "/run/villa-uat-status";
export const BINDING_ROOT = "/run/villa-uat-bindings";
export const BROKER_ROOT = "/run/villa-uat-broker";

export const PRIVATE_DEPLOYMENT_FILES = Object.freeze({
  "usr/local/libexec/villa-uat-control": WRAPPER,
  "etc/systemd/system/villa-engine-uat@.service": SESSION_UNIT,
  "etc/systemd/system/villa-engine-uat-settle@.service": SETTLEMENT_UNIT,
  "etc/systemd/system/villa-uat-broker.service": BROKER_UNIT,
  "etc/tmpfiles.d/villa-uat.conf": "d /run/villa-uat-status 2750 villa-engine villa -\nd /run/villa-uat-bindings 2750 root root -\nd /run/villa-uat-broker 2750 root villa -\n",
});

export const PRIVATE_DEPLOYMENT_MODES = Object.freeze({
  "usr/local/libexec/villa-uat-control": 0o755,
  "etc/systemd/system/villa-engine-uat@.service": 0o644,
  "etc/systemd/system/villa-engine-uat-settle@.service": 0o644,
  "etc/systemd/system/villa-uat-broker.service": 0o644,
  "etc/tmpfiles.d/villa-uat.conf": 0o644,
});

export const PRIVATE_RUNTIME_ENTRIES = Object.freeze([
  "scripts/villa-uat-broker.mjs",
  "scripts/lp-account-session-service.mjs",
  "scripts/lp-account-session.mjs",
  "scripts/lp-account-settlement.mjs",
]);
