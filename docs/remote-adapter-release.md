# 远程 adapter 的发布与边界

本文件规定 `haish-agent-remote` 里哪一部分会被桌面客户端托管、如何发布，以及两边共享的运行期契约。

## 边界：只有 adapter runtime 进桌面客户端

桌面客户端只消费本仓库冻结出的产物，它们等价于 `server/` 这一个 Python 模块：

| 本仓库内容 | 进桌面客户端 | 说明 |
| --- | --- | --- |
| `server/`（FastAPI adapter：配对、鉴权、runtime 转发、隧道看护） | ✅ 唯一一项 | 冻结为单个可执行文件 |
| `frpc`（fatedier/frp 官方客户端二进制，随 Release 提供） | ✅ | adapter 用它建立公网隧道 |
| `dist/`（本机网页版静态文件） | ❌ | 缺它只让 `/` 返回 503，`/remote/*` 不受影响 |
| `src/`、`package.json`、`capacitor.config.ts`、`ios/` | ❌ | 手机 IPA 管线 |
| `scripts/` | ❌ | 构建工具不随运行时分发；adapter 构建入口见下文 |
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

## 远程桌面扩展（实现，待真机验收）

保持上述单可执行文件消费契约；PyObjC/Quartz/ApplicationServices、PyAV、aiortc 均冻结在 adapter 内，不新增需桌面 App 托管的 helper。CI 显式收集这些模块，设置 `MACOSX_DEPLOYMENT_TARGET=14.0`；目标运行机仍为 macOS 14.8.9 / arm64，不能因 runner 为 15 就宣称下限为 15。

adapter 同进程另开 `127.0.0.1:8767` 本机管理页（`HAISH_DESKTOP_MANAGEMENT_PORT` 可覆盖），不能加入 FRP/Nginx 转发。手机只使用 8766 上已鉴权的 `/remote/desktop/*` 信令；开关不在该监听上。可选新增环境变量 `HAISH_DESKTOP_TURN_URLS` 与 `HAISH_DESKTOP_TURN_SECRET` 供自托管 coturn 短期凭据签发。操作、TURN 配置及验收限制见 [远程桌面实现说明](remote-desktop.md)。冻结产物权限主体/升级保留和最终 CI 产物在 14.8.9 上运行仍须验收。

## 开发路径

源码运行方式不变（见 README 的 Development 一节）。本地复现冻结产物使用 workflow 的固定构建工具、`python scripts/build-packaged-media.py` 和 `pyinstaller scripts/remote-adapter.spec`；不要把本地冻结包当作发布入口。可用 `--work-dir` 指定隔离目录，`--archives` 指向已下载的固定源码归档；`HAISH_PACKAGED_MEDIA` 为 spec 指定其 `package` 子目录。

### 合并 PyAV 原生映像

经用户授权采用构建期合并方案：固定 PyAV 16.1.0、Cython 3.1.4 与 FFmpeg 8.0 **头文件**，源码归档 SHA256 由构建脚本校验、安全解压。FFmpeg 不重新编译、不使用本机 Homebrew 库；沿用原 PyAV wheel 的 `.dylibs`，校验主要 ABI，并输出各库哈希。49 个 Cython 扩展分别编译，只有导出的初始化符号改为唯一名，然后链接为一个 `_native.so`；模块全名和类型/C API 名保持原样。部署目标 14.0，重写自身依赖到包内相对路径后正常 ad-hoc 签名/校验；PyInstaller 再按原流程签名，未关闭系统安全检查。

`server/packaged_media.py` 只在 macOS 冻结媒体工作线程中注册包内映像的加载器，以同一 dlopen flags/GIL-safe 方式加载，初始化成功或失败均平衡自己的句柄；原 CPython 错误保留。源码使用上游 wheel，无 manifest 的旧冻结包保持原加载路径。spec 排除原 wheel 的扩展，收集合并包、原 FFmpeg、元数据和许可证。构建输出 `native-build.json` 与 `PyAV-LICENSE.txt` 为随包审计资料；单可执行文件的桌面消费契约不变。不得将模块导入计时或本地实验首帧当作最终 Actions/手机验收。

此方案增加原生构建与私有 CPython 导入 API 的维护成本。升级 Python/PyAV/Cython/FFmpeg 必须重新固定来源和 ABI、导出符号/模块清单、导入失败/并发测试、编码解码及冻结实际首帧回归，不能直接改版本复用旧映像。冷加载预算仍以需求为准，不提高协商/启动超时。
