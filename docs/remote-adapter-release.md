# 远程 adapter 的发布与边界

本文件规定 `haish-agent-remote` 里哪一部分会被桌面客户端托管、如何发布，以及两边共享的运行期契约。

## 边界：只有 adapter runtime 进桌面客户端

桌面客户端只消费本仓库冻结出的产物，它们等价于 `server/` 这一个 Python 模块：

| 本仓库内容 | 进桌面客户端 | 说明 |
| --- | --- | --- |
| `server/`（FastAPI adapter：配对、鉴权、runtime 转发、隧道看护） | ✅ 唯一一项 | 冻结为单个可执行文件 |
| `frpc`（fatedier/frp 官方客户端二进制，随 Release 提供） | ✅ | adapter 用它建立公网隧道 |
| `dist/`（本机网页版静态文件） | ❌ | 缺它只让 `/` 返回 503，`/remote/*` 不受影响 |
| `src/`、`package.json`、`capacitor.config.ts`、`scripts/`、`ios/` | ❌ | 手机 IPA 管线 |
| `tests/` | ❌ | 开发期测试 |
| 桌面仓库的 pinned checkout `6f07dc16…` | ❌ | 只服务网页层构建；adapter 侧对它零引用 |

两边在构建期互不拉源码、互不 pin；唯一的声明式引用是"产物 + 版本 + sha256"。运行期只共享下面列出的 HTTP/URI 契约与隧道环境变量。

## 发布流程

唯一支持的发布方式是 [`build-remote-adapter.yml`](../.github/workflows/build-remote-adapter.yml)：

1. 版本的单一事实来源是 `pyproject.toml` 的 `project.version`；
2. 打 tag `adapter-vX.Y.Z` 并推送（与 `pyproject.toml` 不一致时构建失败），或在 Actions 里对 `main` 手动 dispatch 干跑（只出 artifact，不建 Release）；
3. CI 在 `macos-15`（arm64）上运行 `python -m unittest`，用 PyInstaller 把 `server/app.py` 冻结成单文件，从 fatedier/frp 的 pinned 版本取 `frpc`（校验 sha256），再冒烟验证 `--version`、`/remote/status` 与隧道监督；
4. tag 构建自动创建 Release，产物为：

   - `haish-remote-adapter-macos-arm64` + `.sha256`
   - `frpc-macos-arm64` + `.sha256`（来自 fatedier/frp `v0.71.0`，Apache-2.0，附 `frpc-LICENSE`）

桌面客户端按版本取产物、校验 sha256，再放进自己的资源目录并由客户端进程托管（客户端那一半实现在 `haish-agent` 仓库）。不支持在本机手打发布包。

## 隧道：adapter 自己拥有公网入口

桌面客户端把服务器设置作为环境变量传给 adapter；adapter 生成 `frpc.toml`（`0600`，含 token）并看护 `frpc` 子进程：

- 崩溃自动重启，退避 1s → 30s；一次运行稳定超过 60s 后失败计数清零；
- 正常退出（含 SIGTERM）时随 lifespan 关闭一并停止 frpc，不留孤儿进程；若上一次是强杀（SIGKILL）留下的 frpc，下一次启动会按 `frpc.pid` 记录回收（校验该 pid 的命令行确实指向本数据目录的配置，不误杀无关进程）；
- 状态经 `/remote/status` 的 `tunnel` 字段上报（`enabled` / `running` / `pid` / `server` / `remote_port` / `restarts` / `last_error`）；token 不出现在日志与状态里；
- 启用但没有配齐或 frpc 不可执行 → 启动即报错退出，不静默降级。

| 变量 | 含义 |
| --- | --- |
| `HAISH_REMOTE_TUNNEL` | `1` 启用隧道 |
| `HAISH_REMOTE_TUNNEL_SERVER` / `HAISH_REMOTE_TUNNEL_SERVER_PORT` | frps 主机 / 端口（默认 `7000`） |
| `HAISH_REMOTE_TUNNEL_TOKEN` | frps auth token |
| `HAISH_REMOTE_TUNNEL_REMOTE_PORT` | frps 为本机暴露的公网端口 |
| `HAISH_REMOTE_FRPC` | frpc 二进制路径（桌面客户端随包提供） |

## 二进制契约

- 命令：`haish-remote-adapter serve [--host 127.0.0.1] [--port 8766]`、`haish-remote-adapter pair`、`haish-remote-adapter --version`；
- 监听固定为 `127.0.0.1:8766`（端口是每台电脑自己的命名空间，跨机器不冲突）；
- 环境变量：`HAISH_REMOTE_PUBLIC_ENDPOINT`（配对二维码的 https origin；缺失时 `POST /remote/pairing/start` 返回 503）、`HAISH_UPSTREAM_URL`、`HAISH_RUNTIME_PID_FILE`（缺省按 `runtime.pid` 自动发现本机 runtime）、`HAISH_REMOTE_DATA_DIR`（默认 `~/.haish-remote`）、隧道变量见上；
- 桌面客户端调用 `POST /remote/pairing/start`、`GET /remote/devices`、`DELETE /remote/devices/{device_id}`，并读 `GET /remote/status`（含 `version` 与 `tunnel`）展示 adapter 与隧道状态；
- 手机端契约：`haish://pair?v=1&endpoint=…&code=…` 配对 URI，`/remote/*` 与 allowlist 内的 `/api/*` 转发；
- adapter 不安装、不启动 core runtime；runtime 由桌面客户端负责拉起。

## 开发路径

源码运行方式不变（见 README 的 Development 一节）。本地要复现冻结产物时，照抄 workflow 里的 PyInstaller 命令即可；不要把它当作发布入口。
