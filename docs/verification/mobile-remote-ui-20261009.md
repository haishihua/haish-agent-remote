# Mobile remote desktop UI — implementation and real-device verification

## Delivered source and artifacts

- `fde1bf5850bad79a91b54d06e0e4c7bf7bfe1764`: redesigned Settings/Remote Desktop; WenKai typography; real metrics; isolated/tested gesture recognition.
- `652f0b5f0093ee9aec89991f585dd3abf51724fa`: browser timer receiver fix discovered during phone acceptance. Bare `setTimeout`/`clearTimeout` assigned as class methods throw `Illegal invocation`; globalThis wrapper regression added.
- User explicitly authorized scoped commit/push, Actions builds, installation, temporary adapter replacement/local enable. Existing glossary/requirements/history changes excluded. User subsequently requested autonomous non-destructive checks and deferral of uncertain items.
- Final IPA Actions [37831599751](https://github.com/haishihua/haish-agent-remote/actions/runs/37831599751) succeeded; SHA256 `f3554859fd1fc4182e35d4640c5db523d77fc8e3d865acf4f1eaf1e7d75ce3da`; **1.91/build91**, minimum iOS15. Sideloadly Done/100% and go-ios installed version independently confirmed. No uninstall or local Xcode packaging.
- Adapter Actions [37829886040](https://github.com/haishihua/haish-agent-remote/actions/runs/37829886040) succeeded for fde1bf5. Bundled adapter/frpc SHA256 and strict signature check passed. Server source unchanged by 652f0b5. Existing managed executable not overwritten; binary used only temporarily.

## Implementation

Settings follows supplied dark design: compact laptop summary, actual computer/model/runtime state, blue Open Remote, read-only Manage, grouped paired-device count/rows, destructive confirmation, bottom sign-out card. Manage cannot enable access or alter permissions remotely.

Remote page follows supplied video/HUD/toolbar/dotted-trackpad/computer-bar layout. No stock desktop image, fabricated resolution/latency or fake audio controls. Optional metrics expose only measured resolution/fps/RTT/direct-vs-relay, no addresses or credentials. RTT is not end-to-end input latency. Existing freshness/lease/security retained. Text/shortcuts/options separate panels; Cmd/Shift/right-click/release also available beside trackpad. Long press dragging, pinch zoom and two-finger scrolling tested; parallel scroll classification waits for both fingers to move. Cancellation/panel navigation/exit release held input and clear pending clicks.

## Automated verification

- JavaScript **366 passed** (43 gesture tests, 22 desktop-session tests included).
- Python **103 passed** using `.venv-desktop/bin/python`; bare system `npm test` Python phase initially failed because system Python lacks av/aiortc. No test suppression or dependency workaround; actual project environment passes.
- Web build, `mobile:sync`, style check, diff whitespace pass.
- Headless Chrome isolated Remote component: Connect error path, Keyboard panel, Back callback pass; zero page errors after timer fix. Browser reproduction: old timer `Illegal invocation`, bound wrapper `ok`.
- Existing unrelated BrowserRuntimeCard export/chunk warnings retained; not an approval-flow acceptance claim.

## Actual current phone checks

Device: iPhone15,4 / iOS17.5.1; Mac Apple Silicon/macOS14.8.9. Installed 1.91; actual Actions adapter; existing pairing/public HTTPS tunnel/VPN unchanged. Preflight supported, screen recording, accessibility and unlocked true; default enabled false, TURN false. Access enabled only via loopback CSRF management during test.

1. Settings layout/font/model/3 real paired devices visually checked in iPhone screenshots. Revoke/logout not executed against real devices.
2. Initial build90 remote Connect/Back silently failed while Expand worked. Actual UI defect preserved, not accepted; fixed in build91. Final Connect succeeds and Back ends control.
3. Actual iPhone screenshots show live Mac display, changing ordinary TextEdit content, **1660×1080**, RTT samples **9–34ms**. No first-frame timing claim: cold media load 9.7316s, phone connected after warm loader. No selected candidate confirmation captured; TURN unavailable.
4. WDA populated exact `Haish远控验收abc中文🙂`; unobscured Send submitted, mobile field cleared, independently read **entire exact text in disposable TextEdit document**. One Enter added one newline. Local activation/focus was setup, not proof of remote click-to-focus.
5. Keyboard-open measured textarea y351/h64, Send y427/h44, native keyboard y561; Send unobscured. Screenshot visually confirms form above keyboard. A later Hide keyboard lookup found no button because keyboard had already dismissed; no hide-action pass inferred.
6. Real single-finger trackpad movement changed native cursor **(330,240) → (545.122,240)**. Normalized motion effect confirmed, not exhaustive precision/performance mapping.
7. Real two-finger pinch changed option zoom to **1.5×**, visually captured. Portrait/landscape rotation during active video succeeds, stream stays busy. Landscape remains centered/narrow with scrolling controls; full landscape usability is not accepted.
8. Long-hold gesture submitted with native errors zero; no disposable-item movement observed, so **drag item effect unverified**. Two-finger scroll and double click only automated regression evidence this round, not final physical outcome.
9. Right-click received/accepted with zero native errors; screenshot did not show context menu. **Right click remains unverified**, not passed from counters.
10. Back yields busy=false. Native deactivate2s yields `Not connected` / `App left the foreground. Reconnect manually.` and server busy=false. Explicit reconnect succeeds. No background stale-input replay observed; no destructive Mac lock/sleep/TCC/revoke tests run.
11. Temporary adapter alive for roughly 13.5min total, but active uninterrupted phone connection only ~2.5min plus short reconnects. Streaming samples ~367–553MB RSS, zero memory guard/native errors/spontaneous exit. **Not a 10min streaming/P95/stability pass.**

Evidence screenshots/logs/harnesses under ignored `tmp/ui-redesign/`. Live desktop screenshots may contain personal desktop/account information: keep local, do not publish them or attach to public issue/commit. Test TextEdit document remains unsaved; user files untouched.

## Remaining and handoff

UI and basic actual phone screen/text/mouse/lifecycle verified; comprehensive remote-desktop acceptance incomplete. Deferred: TURN deployment/forced relay/cellular path, measured cold phone first-frame, continuous10min/direct/relay input-to-frame P95, full scroll/right-click/drag/double-click/modifiers/Spaces, iOS15 runtime, disruptive lock/sleep/permission/revoke, landscape optimization. Audio/clipboard/file transfer intentionally unsupported.

Temporary adapter disabled and original managed adapter restored after testing; final runtime/tunnel and persisted enabled=false checked at cleanup. New phone app remains installed, but original adapter0.2.4 has no working desktop endpoint: durable desktop-client adapter upgrade must be confirmed later. No cross-repository binary replacement, permanent service, TURN/network/TCC change or core task mutation performed. Owned WDA sessions/runner/forward and Vite stopped; existing userspace tunnel preserved.
