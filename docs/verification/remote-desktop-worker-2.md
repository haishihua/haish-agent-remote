# Worker 2 — input freshness P1 repair evidence

## Conclusion

The executable P1 from the independent verifier handoff has been repaired and regression-tested. **Final acceptance remains with verifier**; physical packet outage, real iPhone/IPA, final CI artifact/TCC upgrade identity, actual application input/lifecycle, TURN/network and performance are still unverified. Baseline is `docs/requirements/goal.md`; historical pending approval notes are not a new gate. Initial evidence/acceptance mapping remains in `remote-desktop-worker.md`, now marked historical. Current protocol is in `../remote-desktop.md`.

Repair context: `/private/var/folders/44/msp5kxc959q17dv4zp93n2nc0000gn/T/317a15c93ef44049882033656e61efe0-goal_verifier-1-afbf2b3befc34024b13dccc9bb05e939.md` (CONTINUE: buffered reliable SCTP input accepted after client pause or returning ping).

## In-scope changes

- `server/desktop.py`: commands require generation + server epoch + opaque **server-issued expiring ticket** + sequence. Tickets expire 1 second from server issuance, irrespective of later pings. Control expires before processing a returning packet, not just in watchdog. Suspend clears tickets, rotates epoch, releases held state and disarms capture/input. A ping alone never resumes; `ping → challenge → resume → ready` is required. Older client generations cannot restore control. Tickets are pruned and bounded. Handshake acknowledgment loss reissues a challenge instead of keeping an unseen armed state.
- `src/desktop-session.js`: input channel is ordered partial-reliable with `maxPacketLifeTime: 250`; no unlimited reliable retransmission. Each probe is correlated to local monotonic send time; reply validity cannot start anew on delayed receipt. Client deadline is at most 750ms from its probe send; pause invalidates every outstanding probe and starts a new generation. Buffered ready/challenge is ignored; a fresh challenge and acknowledged resume are necessary before input. No pending input is replayed.
- Partial-reliable input can drop key-up/button-up. Heartbeats therefore advertise current held state; server only **releases** absent keys/buttons, never reconstructs a missing down. Client records release intent even when backpressure prevents sending an up. Pause clears local held state; server suspend releases all. This also protects combinations/explicit drag from lost releases.
- `tests/test_desktop.py`, `tests/desktop-session.test.mjs`: expanded deterministic delayed-delivery/liveness/held-release coverage and updated real media handshake integration. No product boundary, minimum OS, pairing or task protocol changes.
- `docs/remote-desktop.md` updated to current wire/lifecycle semantics; initial worker evidence retained as historical, linked here. New client and adapter versions must be deployed together for this desktop protocol; old bare pings cannot arm the repaired server (fail closed). Release/IPA deployment not performed.

## Actual checks on macOS 14.8.9 / arm64

| Command / check | Result |
| --- | --- |
| `PYTHONDONTWRITEBYTECODE=1 .venv-desktop/bin/python -m unittest discover -s tests -p 'test_*.py'` | **79 passed**, zero skipped/failed; final run 7.411s (74 prior + 5 freshness test methods) |
| `node --test tests/*.test.mjs` | **315 passed**, zero skipped/failed (309 prior + 6 new methods); 530.815ms |
| `./node_modules/.bin/vite build --outDir <OS-temp-directory>` | Passed, 6.67s; existing generated CSS reused, no IPA build |
| `node scripts/verify-bundled-styles.mjs <temp-output>/assets` | Passed existing bundled style checks, not remote gesture/layout acceptance |
| Development single-file PyInstaller rebuild using workflow collection flags and `MACOSX_DEPLOYMENT_TARGET=14.0` | Passed; `build/desktop-check/haish-desktop-dev-check --version` loads on 14.8.9 and reports 0.2.3. Not CI/release/frozen capture acceptance |
| `git diff --check` | Passed |

Web output: `/var/folders/44/msp5kxc959q17dv4zp93n2nc0000gn/T/haish-worker2-web-final.ib7yQM`. Ephemeral metadata logs: `/tmp/haish-desktop-worker2-{python,node,build,freeze}.log`. Durable outcomes are this record. Build still emits the previously observed missing `BrowserRuntimeCard` export warning from the local desktop checkout seam and large-chunk warning; these are not repaired/claimed resolved by this P1 patch. Python testclient deprecation warning remains. No overall suite failure.

## Reproduction now rejected

Deterministic real server class tests use a fake monotonic clock and mock input backend, never the user's desktop:

1. At time 100 perform full initial handshake; one valid Cmd-down accepted.
2. At time 102, 102.5, 103 or 108 deliver old ticket/epoch text/key, both **before** a returning ping and **after** that ping. Every case rejects it; epoch rotates, input/capture remains disarmed and release is invoked.
3. A fresh higher-generation handshake succeeds; old commands remain rejected, a new-ticket command is accepted once.
4. Keep normal heartbeats flowing so epoch stays active, but delay a command beyond its original ticket deadline. It is rejected even though control is currently active; newly issued ticket works. This is not a constant-only fix.
5. Old-generation heartbeat/old resume cannot re-arm. Dropped resume-ready acknowledgment prompts a new challenge. Lost key-up/button-up is released by heartbeat; missing down is not replayed.

Client tests retain a simulated already-submitted transport packet, then pause at a 2.5s gap: buffered ready/challenge cannot re-enable input, unsolicited ready is refused, new probe/challenge/resume/ready restores only the fresh generation. Tests also cover late replies before the tick, expiry anchored to probe send, 30s timeout, packet lifetime configuration, and release intent when an up is dropped by backpressure.

The real aiortc test uses synthetic frames and ordered partial-reliable SCTP over local DTLS. It performs the new handshake, accepts a valid initial text into the mock backend, waits 1.1s without heartbeats, attempts stale input before ping, completes generation-1 recovery, attempts stale input after recovery, and accepts only new input. Synthetic video negotiation, concurrent busy, disable/revoke/logout/permissions and existing task regressions still pass. This is a **real transport with an application heartbeat gap**, not a physical network outage or iPhone WebView interoperability test.

## Acceptance tracking / concrete remaining limits

- Disconnect stale-input P1: repaired with server command validity plus handshake, client generation/probe gating, bounded transport, release reconciliation. Deterministic and local transport evidence above. Physical loss/delay/reordering test on a real paired phone still required, including no residual Cmd/mouse drag after recovery.
- Foreground-only/max 30s, concurrent busy, active revoke/logout/disable/permissions: automated coverage remains green. Actual phone background/lock/page exit, Mac sleep/lock and adapter-exit cleanup not exercised this round.
- Capture/input/keyboard/Spaces/view: initial source capture and construction evidence referenced in prior record; no new actual-screen capture or application input injected. Real Chinese/English/emoji, gestures, zoom/rotation/resolution and Spaces remain unverified.
- CI single-file target macOS 14.8.9 / arm64 and iOS 15: unchanged; development freeze/version load is not the final Actions artifact. TCC first-grant/revoke/upgrade stability and Swift/IPA compilation remain gates.
- TURN/direct/cellular/restricted networks: no authorized provisioned relay or real-phone path available in supplied artifacts; no deployment attempted. Template/server syntax, transports (aiortc uses one TURN URI at adapter end), allocation refresh past REST credential lifetime require real tests.
- Performance: no direct/relay 10-minute run, synchronized input-to-image P95, first-frame-from-Connect or FPS/device/network measurements. No RTT substitution; no performance acceptance claimed.
- Task/pair/revoke user flows: suites pass; real phone regression remains. No core tasks cancelled.

Only this repository was edited. No credentials, desktop pixels or input content logged; mocks use synthetic input. No TCC changes/prompt, system lock/sleep, external writes, purchases, push/tag/release, local Xcode/IPA build or permanent services. Requirements and supplied prior handoffs were not rewritten. Verifier should recheck this P1 with its original failure dimensions, then pursue the remaining device/infrastructure gates under their existing authorization boundaries.
