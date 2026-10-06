# Remote desktop worker verification record

## Conclusion

Historical first-worker record. The independent verifier subsequently found an input-freshness P1 despite these green tests; the repair/current evidence is [worker 2 record](remote-desktop-worker-2.md). Do not treat this initial record as proof of disconnect acceptance or current protocol semantics.

Implementation is in place in this repository only. **Not final acceptance**: real iPhone WKWebView/IPA, actual application input, deployed TURN, 10-minute performance and TCC upgrade identity remain unverified. Requirements baseline: `docs/requirements/goal.md`; operating/protocol/config details: `docs/remote-desktop.md`. No separate verification handoff was supplied; this is the first worker evidence record.

## Actual evidence

Environment: Apple Silicon arm64, macOS **14.8.9** (23J631), Python 3.13.3, Node 23.11.0. New dependencies installed into ignored `.venv-desktop`; no global Python/runtime dependency edits. System permission preflight reported Screen Recording and Accessibility already available for this execution context; **no permission prompt was requested and no TCC setting was changed**.

| Check | Result |
| --- | --- |
| `node --test tests/*.test.mjs` | 309 passed, 0 failures/skips (301 existing + 8 desktop tests) |
| `.venv-desktop/bin/python -m unittest discover -s tests -p 'test_*.py'` | 74 passed, 0 failures/skips (65 existing + 9 desktop tests), final run 6.861s |
| `npm run build` | Passed; pre-existing large-chunk warning remains |
| `npm run check:styles` | Passed bundled desktop/mobile style checks |
| `git diff --check` | Passed |
| Actual `MacDesktop.status()` on 14.8.9 | supported / screen_recording / accessibility / unlocked all true |
| Actual `MacDesktop.capture()` | Main-display capture converted to **1660×1080 yuv420p** (aspect-preserving under max 1080p). Only dimensions/format observed; no pixels logged, persisted or transmitted |
| Unicode bridge construction | Created CG keyboard event carrying 中文 + emoji UTF-16; **did not post input** |
| aiortc integration | Real offer/answer + local DTLS/SRTP video + data-channel ready acknowledgment with synthetic 320×180 frames; busy rejection and disable cleanup pass. Not actual-screen/iPhone/TURN acceptance |
| Single-file development PyInstaller build | Passed with the workflow's module collection options, no extra helper deliverable |
| Frozen binary on 14.8.9 | `--version` = 0.2.3; served separate local management page and status with supported=true, enabled=false, busy=false, turn_configured=false; SIGTERM shut down process. Uses isolated temp data and alternate loopback ports, not the user's paired store |
| Mach-O dependency checks | PyAV native module `minos 14.0`; PyObjC universal module x86_64 minimum 10.13 / arm64 minimum 11.0. CI-final artifact not tested |

Raw local logs are ephemeral `/tmp/haish-desktop-{python-tests,node-tests,build,integration,freeze}.log`; they contain test/build metadata only. The durable result is this file, not a promise that those temporary logs persist. Development binary is ignored `build/desktop-check/haish-desktop-dev-check`; not a release artifact or IPA.

## Automated coverage

`tests/test_desktop.py`: authentication/default-off, remote enable unavailable, local Host/Origin/CSRF/forwarded/cross-site restrictions, enable persistence and strict boolean, each permission/platform/unlocked gate, short-term TURN HMAC credential/no permanent secret response, malformed input bounds, stale epoch/sequence replay rejection, device revocation, permission-loss watchdog, real aiortc synthetic video negotiation, concurrent busy, disable cleanup, revoke/logout endpoint stop of active peers.

`tests/desktop-session.test.mjs`: current epoch/sequence input, stale/offline/congested commands discarded (no client queue), 30-second foreground retry timeout, idempotent release/end, missing first frame bounded failure, lock/revoked pairing explanatory failure, bounded ICE wait, native/web lifecycle wiring, no task-cancel path and no iOS-incompatible AbortSignal.timeout dependency.

During real macOS checks, fixed three bridge defects: AX trust APIs belong to ApplicationServices, console-session dictionary uses `kCGSSessionOnConsoleKey`, image provider data can include tail padding larger than the PyAV plane. Existing SQLite connections were made explicitly closed because the new high-frequency authorization checks amplified leaked-connection warnings. This change passed adapter regressions.

## Acceptance mapping (evidence, not declaration of passing)

| Requirement scenario | Implemented / evidence | Remaining acceptance |
| --- | --- | --- |
| Setting entry; preserve tasks | App tab + dedicated component, no task cancellation, regression suites | Actual navigation/state check on phone |
| Default-off/local-only enable | Separate listener, CSRF/Host/Origin/forwarded gates; persistence tests | Actual FRP/public/cross-site penetration scenario |
| macOS permissions | Distinct permission gates and local-only prompt; current real preflight works | First grant/revoke/upgrade and final binary authorization identity |
| Capture/normal input | Real source capture; WebRTC synthetic video; CGEvent bridge | Actual applications, cursor, double/right click/scroll/drag |
| Phone view | Responsive video, zoom/pan, relative trackpad mapping to current screen bounds | iPhone portrait/landscape/zoom/resolution change |
| Keyboard and Spaces/apps | Unicode + allowlisted keys and modifier release paths; construction check | Real editor 中文/English/emoji and configured Spaces/Cmd+Tab |
| Direct + TURN | Signaling/ICE credential implementation; local synthetic direct peer | LAN/cellular-home; deployed forced relay candidate proof |
| Missing/fault TURN | Direct-only warning, ICE/first-frame failure and retry | Real restricted/faulty network |
| Disconnect/concurrent | Lease epochs, drop queues, watchdog, max 30s retry, busy tests | Real packet outage/recovery; inspect held keys/buttons |
| Exit/revocation | Native/web page lifecycle; direct revoke/logout/disable stop; permission watchdog | Real background/phone lock/Mac sleep/lock/permission removal |
| Lock-screen boundary | Fail-closed current session gate, explicit unsupported guidance | Validate actual lock signal; no unlock support claimed |
| Existing capabilities | Full task/pairing/tunnel/server + UI model regression suites | Device/user-flow regression |
| Performance | Adaptive 1080p30 / 720p15 code path | Direct and TURN 10-minute runs, first frame ≤10s and feedback P95≤300ms, synchronized measurements |

## Concrete limits / next verification

- No paired iPhone or Actions IPA was exercised; local Xcode/IPA builds are prohibited by the existing contract and were not attempted. New Swift resign-active hook must be compiled in Actions and tested on actual iOS 15+ WebView. No minimum OS raised.
- No provisioned TURN was supplied and deployment is not authorized in this task. Template/documentation delivered in `docs/turn/coturn.conf.example` and `docs/remote-desktop.md`; no external server changes made. Coturn template syntax/network restrictions and allocation renewal with 10-minute REST credentials need real server tests.
- No actual user-desktop input injected, lock/sleep triggered, or display resolution changed. Permission/lock detection uses current CoreGraphics console-session state; actual lock/sleep termination must be observed, not inferred from fake flags.
- Local single-file load works on 14.8.9, but the **final CI-built adapter** on that OS (and TCC identity across upgrades) remains a release gate. macOS deployment env does not alone prove every bundled dylib is compatible.
- No UI browser/manual rendering or real performance measurements recorded. Performance targets remain requirements, not results. No freeze capture/input session or ten-minute direct/relay benchmark passed by implication.
- No changes to other repositories, no commit/push/tag/release, no TURN deploy, no purchase or permanent background service.

## Final run

After final signaling bounds/cancellation and revoke/logout test changes: Python 74/74 passed; final single-file development rebuild and `--version` passed. Latest client code: JS 309/309, Web build and bundled styles passed. `git diff --check` and local documentation references passed. The final freeze used the same collection flags as the earlier management-page smoke run; it is not a CI release. Verifier owns final acceptance.
