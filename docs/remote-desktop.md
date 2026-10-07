# Remote desktop implementation and verification

Baseline: [requirements](requirements/goal.md), updated with current implementation evidence and remaining acceptance conditions. This implementation is **not final acceptance**. Lock-screen connection/unlock remains deferred.

## Operation and adapter boundary

- Source: install `pyproject.toml` dependencies and run `python -m server.app serve`. Settings → Remote desktop on the paired phone; Connect / retry, End, Back.
- On the Mac open **http://127.0.0.1:8767**. Desktop access defaults off, persists in the adapter data directory's `desktop.json`, and applies to all paired devices. Disable closes the current peer and releases held input.
- Grant Screen Recording and Accessibility to the adapter through System Settings → Privacy & Security. Local Request system permissions is explicit; no remote request prompts for consent. Recheck/restart after changes. Stable authorization across frozen binary upgrades still needs testing.
- The same adapter process owns a second, loopback-only listener. It is **not mounted on 8766**, which FRP forwards. The management listener rejects forwarded headers, foreign Host/Origin, cross-site fetch metadata, and mutations without its per-process CSRF token. Do not proxy or tunnel 8767. `HAISH_DESKTOP_MANAGEMENT_PORT` may change the local port; UI guidance assumes the default.
- Frozen adapter remains one executable, frpc unchanged, no desktop repository or agent core modifications. `.github/workflows/build-remote-adapter.yml` includes PyObjC, PyAV and aiortc. Local freezing is a development compatibility check only, not a release. IPA/release remain Actions-only. User-authorized commit/push, Actions artifact builds and phone installation are recorded in Worker 3/4; no production tag/release or TURN deployment was performed.
- Targets: Apple Silicon macOS 14.8.9; iOS 15 config unchanged. CoreGraphics main-display capture + PyAV downscale/encode + aiortc WebRTC; ApplicationServices accessibility and CGEvent input. No native helper/extra deliverable. PyAV 16.1 arm64 wheel targets macOS 14.0; PyObjC 11.1 wheels target 10.13. CI runner 15 is not the runtime minimum. Final CI frozen artifact still must be tested on 14.8.9.

## Wire and lifecycle

Authenticated HTTPS with existing Bearer/Cookie device authentication:

| Route | Behavior |
| --- | --- |
| `GET /remote/desktop/status` | enabled, permissions, unlocked/supported, busy, TURN configured; no credentials |
| `GET /remote/desktop/ice` | only when desktop ready; fresh 10-minute TURN REST credentials, no-store |
| `POST /remote/desktop/offer` | bounded SDP offer; one peer per Mac; answer + opaque session ID |
| `DELETE /remote/desktop/sessions/{id}` | owner can end its peer; idempotent, cannot terminate another device's peer |

Only a WebRTC data channel named `input` accepts input. It is ordered **partial-reliable** with `maxPacketLifeTime: 250ms`, not an unlimited reliable command queue. Validated messages: normalized relative `move`, bounded pixel `scroll`, left/right `click` (1/2), explicit `button` down/up, allowlisted special `key` down/up, Unicode `text` (≤1024 characters), `release`, `ping`, `resume`. No clipboard/files/audio. Every command carries a monotonically increasing client control generation, server epoch, sequence number and server-issued opaque ticket valid for at most **1 second from server issuance**. Old tickets cannot be refreshed by returning heartbeats. After every pause, input/capture require `ping → challenge → resume → ready`; a heartbeat alone cannot arm a suspended session. The client only accepts replies to outstanding probes within 750ms of its own monotonic send time; it invalidates pending probes on generation change. No clock synchronization is needed. Lost/unsent key-up/button-up/release is reconciled by the next heartbeat's held-state snapshot, which can only release missing state, never synthesize or replay a down. Permissions/device authorization are rechecked per message and before/after frame capture. Watchdog also rechecks permissions/lock/revocation every 250ms. Revoke/logout endpoints directly stop matching active sessions.

Phone foreground ping every 500ms: client input validity ends no later than 750ms from the acknowledged probe's send time; the 500ms tick or late response transitions to paused/new-generation reconnect. Server expires control after 1 second without a ping (checked before processing a returning message as well as by watchdog), releases held state and stops sending frames; orphaned sessions close after 30 seconds. Leaving page/native resign-active/background closes immediately on the client; failed signaling cleanup is bounded by server lease. macOS lock/off-console or scheduler gap (sleep) closes rather than resumes. Foreground network recovery attempts existing ICE recovery for at most 30 seconds, with manual reconnect after failure; no permanent service or prevent-sleep behavior. First-frame timeout is explicit, not an endless spinner.

Video: main display only, max 1920×1080 at target 30fps. Client stats request 1280×720/15fps on high loss or RTT; WebRTC encoder congestion control handles bitrate. Performance remains unmeasured. Relative trackpad movement is independent of video zoom/orientation; screen bounds are queried per movement, capture dimensions per frame. Zoom viewport can pan separately from the trackpad. Double tap, right-click, two-finger scroll, explicit drag; modifier toggles/release-all, Space arrows and Cmd+Tab; Chinese/English text sent explicitly after local IME composition.

## Self-hosted TURN (not deployed)

Use maintained coturn on a server you administer. A template is `turn/coturn.conf.example`; replace placeholders, use trusted TLS certificates and restrict config/secret files to the service owner. Generate a strong random shared secret and give it only to coturn + adapter environment, **never to the phone**. Set these in the existing adapter process environment:

```sh
HAISH_DESKTOP_TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp'
HAISH_DESKTOP_TURN_SECRET='<same private shared secret as coturn>'
```

Provision DNS/TLS, public IPv4, and firewall rules: UDP/TCP 3478, TLS TCP 5349, UDP relay range 49160–49200. Behind NAT configure coturn's `external-ip=PUBLIC/PRIVATE` and forward the full relay range. Ensure realm, listening/relay interfaces and public address match your deployment. TURN is independent of the FRP HTTPS signaling tunnel. Do not configure `no-auth`, permanent mobile credentials, anonymous relay or credential-bearing access logs. Block loopback/private/link-local relay destinations (template); review IPv6 and any deployment-specific internal networks as well. Monitor quota/abuse without storing username/password or desktop/input content. The adapter's HMAC-SHA1 REST credential expires after 600 seconds; test sessions longer than 10 minutes and fresh reconnections to validate allocation refresh behavior.

Restart the adapter after setting environment; the authenticated ICE response should show configured TURN. Phone Force TURN mode uses `iceTransportPolicy: relay` to verify the fallback, not as the default. Validate selected candidate type `relay` through WebRTC stats, not merely a successful SDP exchange. With no TURN the UI warns direct-only; failed ICE/first frame yields manual retry. This document authorizes no external deployment.

## Acceptance evidence and remaining checks

See [initial worker verification record](verification/remote-desktop-worker.md), [input-freshness repair record](verification/remote-desktop-worker-2.md), [Actions/phone repair record](verification/remote-desktop-worker-3.md) and [frozen-input/cold-load investigation](verification/remote-desktop-worker-4.md) for actual commands/results. Full English/Chinese text and Enter have reached TextEdit using real Actions artifacts, but prior failures remain preserved; cold frozen first-connect and performance are unresolved. Startup preload was experimentally withdrawn because it exceeded the unchanged desktop consumer's 30-second startup budget. Loopback management `/diagnostics` returns only session input counters, never payloads/tickets, and is not mounted on the tunneled listener. Automated tests are not substitutes for iPhone/WebView, actual application input, lock/sleep or performance acceptance.

Verifier should prioritize:
1. CI build artifact on macOS 14.8.9 (including native library load, permission identity and upgrade stability); iOS 15 Actions IPA on a real iPhone.
2. True Mac display + input in an ordinary editor (中文/English/emoji), drag/double click/right click/scroll and Spaces/Cmd+Tab; no stuck modifiers after interruptions; resolution/rotation/zoom mapping.
3. Lock/sleep and revoke/logout/disable/permissions lost during control; old data-channel packets must not control after reconnect. Later device is busy, not takeover.
4. Real same-LAN and cellular-home paths; forced TURN, broken TURN and no-TURN; background/lock/page exit and 30s front-end outage recovery.
5. Direct and relay separately for 10 minutes under the requirements' network envelope. Record first-frame, frame rate/resolution, devices/OS, and input-to-frame P95 with synchronized recording; RTT is not interaction latency.
