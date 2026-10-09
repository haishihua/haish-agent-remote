# Authenticated TURN deployment — 2026-10-09

## State (in progress; not cross-network acceptance)

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
- Requested minimal cloud ingress: TCP 3478 + UDP 49160–49167. UDP 3478 recommended for lower latency; TLS TCP 5349 optional fallback. User asked whether so many ports are required; clarified reduced range. Awaiting confirmed cloud ingress before public acceptance.
- Phone cellular acceptance is pending; user said to wait before switching network. Phone package does not need replacing for this server-only capability.
- Actual relay-selected desktop video/data, cellular phone usability and allocation refresh beyond ten minutes remain unverified.
