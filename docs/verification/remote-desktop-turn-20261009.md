# Authenticated TURN deployment — 2026-10-09

## State (public firewall configured; full cross-network acceptance pending)

User authorized deployment to their existing Ubuntu ECS and continuing phone acceptance. No SSH password or TURN shared secret is included in source, report, mobile assets or output.

- Added private persistent `desktop-turn.json` support under adapter data directory. File owner and permissions are checked; environment overrides remain supported. Both authenticated ICE signaling and server peer negotiation use the same configuration. Status reports only a boolean.
- Source implementation: `f458d3d88d9cae4c3781c45d7bf197a3754bfb38`; Actions adapter build `37895156275` succeeded. Follow-up test isolation commit avoids reading the real user's private configuration during the direct-only test.
- Full local regression with `.venv-desktop` on PATH: 370 JavaScript tests and 115 Python tests passed. An initial system-Python run failed because optional av/aiortc modules were absent and an older test read the newly created user configuration; that run is not a pass.

## Server deployment

- Ubuntu 22.04, coturn installed through existing apt repositories. No OS upgrade/reboot, existing service restart, VPN change or FRP port change.
- coturn enabled as a systemd service with REST shared-secret authentication, 600-second adapter credentials, allocation quotas, bandwidth caps, and denied private/loopback/multicast peers.
- Independent listeners: UDP/TCP 3478 and TLS TCP 5349. NAT public/private mapping configured. After user asked about number of ports, relay range reduced from template 49160–49200 to **49160–49167** (8 ports for this small deployment).
- TLS uses copies of the existing trusted IP certificate; a scoped certbot deploy hook updates coturn copies and restarts only coturn on certificate renewal. Existing certbot renewal timer observed. Actual future renewal is not yet verified.
- Original `/etc/turnserver.conf` retained as `/etc/turnserver.conf.before-haish`. Private new config readable only by root/service group. No verbose credential-bearing coturn logs.
- Existing frps, nginx, MySQL and cookbook service remained active after deployment.
- Private local TURN configuration created with mode 0600, outside repository, for persistent managed startup. Shared secret generated randomly and transmitted over authenticated SSH without logging.

## Evidence and limits

- Internal TLS handshake verified on server (trusted certificate, TLS 1.2).
- Authenticated allocation through task-owned SSH forwarding **passed**, producing public relay address and a port within 49160–49167. This establishes service/authentication/NAT advertisement only, **not public relay usability**.
- Initial public allocations from Mac failed: UDP/TCP timeout, TLS connection reset. Server captures during those attempts observed no TURN traffic; Mac route uses an existing VPN tunnel, and interface-scoped attempts also timed out. Cause is not established; cloud security-group rules and VPN path require verification. Do not claim these failures prove only one cause.
- Under explicit user authorization, used the authenticated Alibaba Cloud Light Application Server console for the specified instance and added exactly three enabled firewall rules: TCP 3478, UDP 3478, UDP 49160/49167, all source 0.0.0.0/0. Refreshed the page to confirm persistence. The original seven rules were preserved, producing ten total. TCP 5349 was not opened.
- Phone cellular acceptance is pending; user said to wait before switching network. Phone package does not need replacing for this server-only capability.
- Installed Actions artifact after checksum/signature verification. SHA256: `618df580407ab21640886d699c30f7408b1fe3eb52e07c55e8ba0394b8a7c704`. Previous native-resolution adapter retained as `haish-remote-adapter.backup-before-turn-f458d3d`. Independent managed-service check confirmed enabled true, busy false, turn_configured true. The restart helper itself was interrupted; only the subsequent independent readiness check establishes success.
- Phone remains installed at 1.94/build94; no reinstall required or attempted for this server-only capability.
- Forced-relay video attempt after adapter replacement failed before negotiation because no public relay allocation was obtained. Its temporary pairing was removed and original pairing IDs were preserved; no video/data relay pass is claimed.
- After firewall configuration, public authenticated UDP and TCP TURN allocations passed (relay ports 49163 and 49164). TLS public allocation still fails; 5349 was intentionally not opened. These allocation results do not prove actual video/control forwarding.
- First two post-firewall local video tests received video but nominated host/host paths despite SDP relay filtering/test transport policy; their relay assertions failed. They are not accepted as relay evidence. A subsequent test removed local host transports and then filtered server candidates to relay only; actual received video timed out. Cause remains unresolved and may involve the same-Mac/VPN/relay-to-relay test topology; it is not evidence of successful cross-network desktop.
- All temporary test pairings were removed and original device IDs preserved. Actual relay-selected desktop video/data, cellular phone usability and allocation refresh beyond ten minutes remain unverified.
