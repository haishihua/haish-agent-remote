# Haish Remote

Haish Remote is a small mobile UI and authenticated adapter for the existing local
Haish Agent runtime. It does not run another agent and does not change
`haish-agent-core` business logic.

```text
iOS/Android app -> public HTTPS + FRP -> Haish Remote adapter -> 127.0.0.1 Haish Agent runtime
```

The adapter owns device pairing, session authentication, a strict API allowlist,
runtime discovery, and draining task streams after a phone disconnects.

## Development

Start the Haish desktop app first. Its runtime writes `runtime.pid`; the adapter
discovers the newest Haish runtime automatically on macOS.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -e .
npm run build
.venv/bin/python -m server.app serve
```

Create a five-minute, one-time pairing code on the computer:

```bash
HAISH_REMOTE_DATA_DIR="$HOME/.haish-remote" .venv/bin/python -m server.app pair
```

Open `http://127.0.0.1:8766` and enter the code for local web development. The
native app uses the versioned QR protocol and stores its Bearer device token in
the platform secure store. Keep both the adapter and core runtime bound to
`127.0.0.1`.

## iOS build policy

The **only supported way to produce an installable iOS IPA is the GitHub Actions
workflow** `.github/workflows/build-ios-unsigned.yml`.

Do not run `xcodebuild`, archive/export commands, or an ad-hoc local IPA script
on the development Mac. The checked-in `ios/` directory is the Capacitor native
project consumed by the hosted GitHub macOS runner; it is not a local packaging
entry point. The workflow performs the complete sequence in CI:

1. checks out this repository;
2. checks out the pinned shared Haish desktop source used for branding;
3. installs dependencies with `npm ci`;
4. runs `npm run mobile:sync` to build the Web UI and copy it into `ios/`;
5. builds the unsigned iOS app on the GitHub-hosted macOS runner;
6. packages and uploads `Haish-unsigned.ipa` as a workflow artifact.

### Standard IPA release procedure

1. Commit all mobile source and documentation changes.
2. Push the commit to the remote `main` branch. GitHub Actions cannot build
   unpushed local changes.
3. Open the repository's **Actions** tab.
4. Select **Build unsigned iOS IPA** and click **Run workflow** on `main`.
5. Wait for every workflow step to pass.
6. Download the artifact named `Haish-unsigned-<commit>` from that run and
   extract `Haish-unsigned.ipa`.
7. Import the IPA into SideStore on the iPhone. SideStore signs it with the
   personal Apple account and installs it.

The artifact is the source of truth. A stale `.haish/artifacts/Haish-unsigned.ipa`
file on a development Mac must not be treated as the latest build unless it was
downloaded from the current successful Actions run.

### Local Capacitor command

```bash
npm run mobile:sync
```

This command is only a local Web build plus Capacitor asset synchronization for
checking the generated files. It **does not compile an iOS app and does not
produce an IPA**. IPA packaging remains GitHub Actions-only.

The development Mac does not need a full Xcode installation. A local machine
with only Command Line Tools is expected to be unable to run `xcodebuild`; this
is not a project failure. If the GitHub workflow fails, diagnose the workflow
logs and fix the source/configuration, then trigger the workflow again.

The only supported native pairing payload is:

```text
haish://pair?v=1&endpoint=https%3A%2F%2F47.97.24.242&code=12345678
```

See [the mobile remote-control design](docs/capacitor-mobile-remote-control.md)
for the security contract, repository layout, server requirements, and
acceptance criteria.

## Adapter release policy

The **only supported way to produce a distributable `haish-remote-adapter`
binary is the GitHub Actions workflow** `.github/workflows/build-remote-adapter.yml`.
It freezes `server/` with PyInstaller and attaches the binary plus its sha256 to
the `adapter-v<version>` GitHub release. The released version is the
`pyproject.toml` version; a tag that disagrees with it fails the build. Every
other part of this repository (the Vite app, the Capacitor project, the tests)
is not part of the adapter artifact. Do not hand-roll a local release build.

See [the adapter release contract](docs/remote-adapter-release.md) for the
boundary table, artifact names, and the runtime contract the desktop client
depends on.

## 开源方案调研结论

没有一个组件可以无改造地替换 Haish Remote：手机端需要理解 Haish 的任务、审批、输入和 NDJSON 事件模型。建议复用成熟的“连接层”思路，而不是引入完整远程桌面：

| 项目 | 可复用部分 | 与 Haish 的适配成本 | 建议 |
| --- | --- | --- | --- |
| [Remodex](https://github.com/Emanuele-web04/remodex) | 本地优先、一次性配对、relay、iOS 端任务控制、审批/steering 思路 | 中 | 最值得参考的产品和安全模型 |
| [T3 Code remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md) | QR/配对链接、LAN/Tailscale endpoint、HTTPS/WSS 部署模型 | 低 | 参考配对和网络接入体验 |
| [247 Claude Code Remote](https://github.com/QuivrHQ/247-claude-code-remote) | 移动 Web/PWA、WebSocket、xterm.js、node-pty、tmux 会话持久化 | 高 | 只有需要“完整终端”时再引入 |
| [Headscale](https://github.com/juanfont/headscale) | 自托管 WireGuard/Tailscale 控制面 | 中 | 多机器/团队部署时使用，不替代应用鉴权 |

当前工程采用的路径是：Capacitor iOS/Android App → 公网 HTTPS/FRP → `server.app` 配对与鉴权 → 严格 allowlist → 本机 Haish runtime。现有页面继续支持会话列表、任务流式输出、停止任务、继续输入、审批/用户输入、模型和 thinking 配置以及设备撤销。

### 后续建议

1. **当前**：保留 HTTP + NDJSON 业务协议，通过 `47.97.24.242` 的 HTTPS/FRP 入口跨网络访问。
2. **配对**：桌面端展示 adapter 返回的版本化 `pairing_uri` 二维码；手机只接受 HTTPS endpoint。
3. **任务与审批传输**：runtime 已删除 NDJSON 任务流与 HTTP resolve 接口，任务流、审批/用户输入都只走 `/api/events/ws` 实时 WebSocket；adapter 持有该 socket 并转成手机现有的 HTTP/NDJSON 契约，取消与继续输入仍是 HTTP 代理。
4. **不要直接引入 node-pty/xterm.js**：Haish 当前是结构化 agent UI，不是远程 shell；终端能力会扩大权限和安全面。

## Configuration overrides

- `HAISH_UPSTREAM_URL`: explicit core runtime URL.
- `HAISH_RUNTIME_PID_FILE`: explicit runtime PID record.
- `HAISH_REMOTE_DATA_DIR`: pairing/session SQLite directory.
- `HAISH_REMOTE_PUBLIC_ENDPOINT`: required public HTTPS origin embedded in the pairing QR code.

## Checks

```bash
npm test
npm run mobile:sync
```

`npm run mobile:sync` is a synchronization check only. To verify a real iOS
installable package, use the GitHub Actions workflow described above.
