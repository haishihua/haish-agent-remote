# Haish 移动端远程控制方案

## 结论

移动端继续使用当前仓库中的 React 界面，通过 Capacitor 生成 iOS 原生工程；以后可在同一仓库增加 Android 工程。业务 UI、任务模型和 API 客户端只有一份，不创建独立 SwiftUI、Android 或移动端仓库。

**iOS IPA 只通过 GitHub Actions 构建。** 开发 Mac 不承担 Xcode 编译、归档、导出或 IPA 打包职责；本地只允许做 Web 构建和 Capacitor 资源同步检查。GitHub Actions 的 macOS Runner 内部会使用 Apple 的 `xcodebuild` 完成真正的 iOS 编译，这是云端流水线实现细节，不是本地发布链路。

第一阶段由 GitHub Actions 在 macOS Runner 上构建未签名 IPA，再由 iPhone 上的 SideStore 使用个人 Apple 账号签名安装。App Store、TestFlight、推送通知和多用户服务不在本阶段范围内。

## 唯一运行链路

```text
iOS App（React + Capacitor）
        │ HTTPS + Bearer device token
        ▼
https://47.97.24.242
        │ Nginx 443 → 127.0.0.1:18766
        │ FRP server 7000 ← encrypted tunnel
        ▼
Mac 上的 FRP client
        │ loopback
        ▼
Haish Remote adapter（127.0.0.1:8766）
        │ strict API allowlist
        ▼
Haish Agent runtime（127.0.0.1）
```

当前已验证的部署约束：

- 公网服务器：`47.97.24.242`；
- FRP server：TCP `7000`，需要云安全组放行；
- Nginx：公网 `443` 转发到服务器本机 `127.0.0.1:18766`；
- Mac FRP client：连接服务器 `7000`，将本机 `127.0.0.1:8766` 映射到服务器 `18766`；
- adapter 和 Haish runtime：始终只监听 `127.0.0.1`；
- `18766` 不应对公网开放，只供服务器本机 Nginx 访问；
- 公网入口必须使用 iOS 信任的 HTTPS 证书，不使用 HTTP、自签名证书或关闭 ATS 的兼容路径。

## 仓库结构

```text
haish-agent-remote/
├── src/                    # Web、iOS、Android 共用 React 代码
├── server/                 # 只运行在 Mac，不打入手机包
├── tests/                  # 共用协议和 API 测试
├── docs/                   # 架构与部署文档
├── capacitor.config.ts     # Capacitor 唯一配置
├── ios/                    # Capacitor iOS 工程，供 GitHub Actions 使用
└── .github/workflows/      # 唯一 IPA 构建入口
```

`ios/` 是提交到仓库并由 CI 使用的 Capacitor 原生工程，不代表需要在开发 Mac 上安装或运行 Xcode。Capacitor 只把 Vite 的 `dist/` 复制进原生应用；Python 服务和 Haish runtime 始终留在电脑端。

## 配对协议

电脑客户端展示二维码，二维码只接受以下版本化 URI：

```text
haish://pair?v=1&endpoint=https%3A%2F%2F47.97.24.242&code=12345678
```

字段规则：

- scheme 必须为 `haish`，host 必须为 `pair`；
- `v` 必须为 `1`；
- `endpoint` 必须为 HTTPS origin，不允许用户名、密码、路径、查询参数或 fragment；
- `code` 必须为 8 位数字，是五分钟有效且只能使用一次的配对码；
- 不解析 JSON、纯数字或 HTTP 地址等旧格式。

扫码后的流程：

1. iOS App 向二维码中的 endpoint 调用 `POST /remote/pairing/exchange`；
2. adapter 校验一次性配对码，创建设备并返回长期 token；
3. App 将 endpoint 和 token 保存到 iOS Keychain；
4. 后续请求使用 `Authorization: Bearer <token>`；
5. 每次启动读取 Keychain 并调用 `/remote/status`，不再扫码；
6. 收到 401 时删除本机凭证并回到扫码页；
7. 用户主动退出时同时撤销服务端设备并删除 Keychain 凭证。

## 已实现的配对与远程请求接口

以下是当前 `server/app.py` 和移动端 `src/api.js` 的实际接口约定，修改接口或新增客户端时必须同步更新本节。

### 配对接口

| 接口 | 调用方 | 鉴权 | 行为 |
| --- | --- | --- | --- |
| `GET /remote/status` | Web、原生 App | 可选 | 返回 `paired`、`device`、`runtime_online` 和 `computer_model`；未配对也允许访问 |
| `POST /remote/pairing/start` | 桌面端 | loopback 来源 | 生成 8 位一次性配对码和 `pairing_uri`；非本机请求返回 403 |
| `POST /remote/pairing/exchange` | 手机或本地 Web | 无 | 校验配对码，创建设备并返回 token；无效、过期或已使用的配对码返回 400 |
| `GET /remote/devices` | 桌面端、已配对设备 | loopback 或 Bearer/Cookie | 查看未撤销设备列表 |
| `DELETE /remote/devices/{device_id}` | 桌面端、已配对设备 | loopback 或 Bearer/Cookie | 撤销指定设备 |
| `POST /remote/logout` | 已配对设备 | Bearer/Cookie | 撤销当前设备并清除 Web Cookie；原生端随后清除 Keychain |

桌面端必须通过 loopback 调用 `POST /remote/pairing/start`。服务端生成配对码后只在 SQLite 中保存配对码的 SHA-256 摘要，不保存明文配对码；配对码有效期为五分钟，成功交换在事务中标记为已使用，保证同一个配对码不能并发复用。

`POST /remote/pairing/exchange` 根据 User-Agent 或 `sec-ch-ua-model` 记录设备名称，生成随机长期 token，并只保存 token 的 SHA-256 摘要。响应中的明文 token 只返回一次：原生 App 写入 Keychain，Web 端由服务端写入 `HttpOnly`、`Secure`（HTTPS 时）、`SameSite=Strict` Cookie。

### 手机启动与请求流程

```text
1. App 启动
   └─ Keychain 读取 endpoint + token
      ├─ 凭证有效：GET /remote/status（Authorization: Bearer <token>）
      │  ├─ 200：进入远程控制界面
      │  └─ 401：删除 Keychain，回到扫码页
      └─ 无凭证：显示扫码页

2. 首次配对
   └─ 扫描 haish://pair URI
      └─ POST {"code":"12345678"} 到 URI 中的 HTTPS endpoint/remote/pairing/exchange
         └─ 保存返回的 endpoint + token，再进入远程控制界面

3. 手机远程操作
   └─ HTTPS → Nginx 443 → FRP 18766 → adapter 127.0.0.1:8766
      └─ adapter 校验 Bearer token，并按 allowlist 转发到本机 runtime
```

原生 App 的 `src/native-connection.js` 负责系统相机扫码、解析并严格校验 URI、使用 Keychain 保存连接，以及为每个请求生成绝对 HTTPS URL。`src/api.js` 负责附加 `Authorization: Bearer <token>`；收到 401 时自动清除原生凭证。Web 开发模式不使用原生存储，使用同源 Cookie。

### 远程 API 转发与任务流

除配对、状态、设备和退出接口外，远程设备访问 `/api/*` 必须先通过服务端的 `_ALLOWED_CORE_ROUTES` 白名单。当前移动端使用的核心接口包括：

- `GET /api/projects?execution_mode=chat`：加载项目；
- `GET /api/conversations/{id}`、`GET /api/conversations/{id}/tasks`：加载会话和任务；
- `GET /api/tasks/{id}?event_view=runtime`、`GET /api/tasks/{id}/events`：加载任务状态和事件；
- `GET /api/agents`、`GET /api/settings/llm`、`POST /api/llm/models`：加载运行配置；
- `POST /api/conversations`：创建会话；
- `POST /api/messages/images` 及会话图片预览接口：上传和查看图片；
- `POST /api/tasks/{id}/inputs`：发送 steering 输入；
- `POST /api/tasks/{id}/cancel`、`POST /api/conversations/{id}/tasks/cancel`：停止任务；
- `GET /api/approvals/state`：轮询待处理审批；三个 `resolve` 接口不在白名单内，改由 adapter 经实时 socket 下发（见上文）。

启动任务使用单独的远程流式入口，而不是直接开放 runtime 的任务流接口：

```text
POST /remote/conversations/{conversation_id}/tasks
Body: {
  "message": "...",
  "image_attachments": [],
  "options": {
    "execution_mode": "chat",
    "use_history": true,
    "...": "其他运行选项"
  }
}
```

adapter 校验设备后，用 runtime 的实时 WebSocket 启动任务（runtime 已删除旧的 NDJSON 任务流 HTTP 接口，任务流只存在于 `/api/events/ws`）：

```text
GET ws://127.0.0.1:<discovered-runtime-port>/api/events/ws   (Origin: haish://app)
→ {"type":"task.start","request_id":"...","operation":"start","conversation_id":"...","payload":{ message, image_attachments, options, ... }}
← {"type":"command.result","request_id":"...","ok":true}
← {"type":"task.event","request_id":"...","event":{...}}
← {"type":"task.end","request_id":"..."}
← {"type":"command.result","request_id":"...","ok":false,"status":409,"detail":"..."}
← {"type":"task.error","request_id":"...","status":409,"detail":"..."}
```

adapter 把 `task.event` 里的 `event` 逐条转成 NDJSON 行返回给手机；`task.error` 和 `ok:false` 的 `command.result` 用它们自己的 `status` / `detail` 返回普通 HTTP 错误（只放行 4xx/5xx，避免用成功状态包一个错误体），所以启动失败（会话不存在、已有任务在跑、参数非法）依旧是手机端直接提示的错误。socket 由 adapter 持有：手机中途断线不会拆掉 runtime 的 run，adapter 继续读到 `task.end`，任务仍会落到持久化的 `done` / `failed` / `cancelled`，手机重连后轮询这个标准状态即可。如果 20 秒内没有收到第一个事件，adapter 返回 504，但同样不关 socket——runtime 可能只是启动慢，让它跑完，手机仍按标准状态收尾。

审批与用户输入的 resolve 走同一条实时 socket：runtime 已删除 `POST /api/approvals/{id}/resolve`、`POST /api/workflow-approvals/{id}/resolve`、`POST /api/user-inputs/{id}/resolve` 三个 HTTP 接口，adapter 保留手机的 HTTP 契约并在内部转换：

```text
POST /api/approvals/{request_id}/resolve            ← 手机（请求体与旧接口相同）
→ {"type":"approval.resolve","request_id":"...","approval_id":"...","approval_kind":"tool|workflow|user_input","payload":{...}}
← {"type":"command.result","request_id":"...","ok":true,"result":{"ok":true}}
← {"type":"command.result","request_id":"...","ok":false,"status":404,"detail":"Approval request not found or already resolved."}
```

每条 resolve 使用一次短连接、只等待自己 `request_id` 的 `command.result`：runtime 的 `status` / `detail` 原样返回给手机（例如重复处理已解决的审批得到 404），15 秒没有结果返回 504，runtime 不在线返回 503。

adapter 发现 runtime 的顺序是：优先使用 `HAISH_UPSTREAM_URL`，否则读取 macOS/Linux 下最新的 `runtime.pid`。访问本机 runtime 的 `httpx` 客户端统一使用 `trust_env=False`，实时 WebSocket 客户端同样禁用环境代理，避免本地代理影响 loopback 请求。

### 会话运行配置的还原

打开会话详情时，手机按“这个会话实际是用什么跑的”还原服务商、模型和思考等级：runtime 把每个任务的 `request_options` 记在任务上，但 HTTP 契约只暴露粗粒度的 `provider_key`——保存的自定义服务商都叫 `custom`，甚至共用同一个模型——只有客户端当初记录的 selector（`llm-profile-1783479743079`、`custom:opencode_go`）能把它们区分开。adapter 负责把这个 selector 交到手机手上：

- runtime 已经暴露 `request_provider` / `request_model_id` 时原样透传，adapter 不碰本地文件；
- 旧版 runtime 只在磁盘上记着，adapter 从 runtime 自己的状态目录补齐：先读实时增量日志 `conversation_deltas/<conversation_id>.jsonl`（只覆盖 runtime 刚动过的任务），没有就回退到整会话记录 `conversations/<conversation_id>.json`，按 mtime + size 缓存，超过 64 MB 放弃解析；
- 只在 `GET /api/conversations/<id>` 这一个路由上改写响应体（任务、图片子路由不动），改写过的响应不再沿用上游 ETag，也不进入缓存；
- 状态目录取 `HAISH_RUNTIME_HOME`，否则取 adapter 已发现的 `runtime.pid` 所在目录；
- 解析几十兆的会话记录会阻塞事件循环，因此放到线程里执行，实时任务流不受影响。

### 鉴权、错误和撤销行为

- 无效或缺失 Bearer token/Cookie：需要鉴权的接口返回 401；原生客户端清除本地凭证并回到扫码页；
- 已认证设备访问未列入白名单的 `/api/*`：返回 403，不允许把任意 runtime API 暴露到公网；
- runtime 不在线：`/remote/status` 返回 `runtime_online: false`；上游错误由客户端显示为重连状态；
- 桌面端管理设备接口通过 loopback 免设备鉴权，但公网请求仍必须使用有效设备凭证；
- 撤销设备后，其旧 token 立即无法通过认证；
- adapter、runtime 和手机包之间不共享 Cookie、配对码或 token 明文日志。

## Web 与原生边界

- Web 开发模式继续通过 Vite proxy 访问同源 adapter；
- 原生 App 必须先扫码取得 HTTPS endpoint，不能使用写死地址或相对 API；
- Web 使用 HttpOnly Cookie；原生 App 使用 Keychain + Bearer Token；
- UI 和业务状态共用，只有连接初始化、扫码和安全存储调用原生能力；
- 不嵌入线上网页，App 加载安装包内的静态资源。

## iOS 能力

- Capacitor 原生容器；
- 系统相机二维码扫描；
- Keychain 保存连接凭证，且不启用 iCloud 同步；
- `URLSession/WKWebView` 只访问可信 HTTPS；
- App 前台轮询和 NDJSON 流式任务保持现有协议；
- iOS 进入后台后不维持永久网络连接，重新回到前台时立即同步状态。

### 相册选图：一次点击直接进系统选择器

WKWebView 对 `<input type="file" accept="image/*">` 只会弹出系统的 `Photo Library / Take Photo / Choose Files` 动作表，用户还得再点一下才能进相册。所以 App 内自带了一个 Capacitor 插件 `PhotoPicker`（`ios/App/App/PhotoPickerPlugin.swift`，直接编译进 App target）：

- 插件用 `PHPickerViewController` 以 `.pageSheet` 呈现，就是半覆盖的“选择照片”面板，一次点击落到相册网格；
- `filter = .images`、`selectionLimit` 取输入框剩余可添加张数（最多 4 张）、`preferredAssetRepresentationMode = .compatible`，HEIC 相片按 JPEG 返回，和现有 `image/png|jpeg|webp|gif` 白名单兼容；
- 选到的相片复制到临时目录，再用 `portablePath(fromLocalURL:)` 交给 Web 层 `fetch()` 成 `File` 走原有上传流程（`POST /api/messages/images`）；
- 相册面板被划掉没选图时按 `code = "cancelled"` 拒绝，界面什么都不做；
- 长按同一个按钮打开系统的 `Photo Library / Take Photo / Choose Files` 动作表，拍照 / 从“文件”里选图都还在；
- 插件类名就是 JS 插件 id（`PhotoPicker`），而且必须出现在生成的 `ios/App/App/capacitor.config.json` 的 `packageClassList` 里：Capacitor 只在启动时注册这张表里的类，没进表的插件连 JS 头都不会导出，`registerPlugin()` 会直接以 `UNIMPLEMENTED` 拒绝，根本到不了原生代码。`cap sync` 只扫描 npm 插件包，扫不到 App target 里的 Swift 文件，所以 `npm run mobile:sync` 在 `cap sync` 之后追加一步 `scripts/sync-ios-app-plugins.mjs`，把 App target 里带 `@objc(...)` 的 `CAPBridgedPlugin` 类名补进这张表；
- 原生面板调用失败会在会话详情页顶部的提示条里显示错误，不会静默改用文件选择器；
- `AppDelegate` 里保留一处 `PhotoPicker.self` 引用，避免 Release 构建把它 strip 掉；
- 浏览器（Web）下没有原生插件，按钮行为不变（直接打开文件选择器）。

### 会话详情的右滑返回

原生容器的返回手势只有 `WKWebView.allowsBackForwardNavigationGestures` 一条路，它靠 history 快照兜底：iOS 16 起 WebKit 对“没有用户手势创建的 `pushState` 条目”会在返回时直接跳过、不派发 `popstate`（WebKit bug 248303 是刻意加固，不是 bug），而且划动过程中看到的是进入详情时的旧列表。所以右滑返回按主流混合 App（Ionic `ion-router-outlet` 的 swipe-to-go-back）的标准做法完全在 WebView 里做，逻辑集中在 `src/swipe-back.js`：

- 左侧 50px 内按下才开始判定；判定用平移识别器：位移过 8px 且方向落在水平轴 40° 锥角内才认领手势，垂直或向左一律让给消息列表滚动；
- 进度 = 位移 / 屏宽，写成一条 0→100% 线性 Web Animations 动画的 `currentTime`（`surface.animate()` 后 `pause()`，等价于 Ionic 的 `progressStep`）。之前是把偏移写进 CSS 变量 `--swipe-back-offset` 再让 `transform` 去读，每次 touchmove 都要让整棵消息列表重算样式；改动画时间只更新合成器，不碰样式；
- touchmove 按帧合并（一个 rAF 一帧最多写一次），认领手势的那一帧就已经跟着手指走；
- 松手按速度决定去向：> 0.2 px/ms 或过了半屏就完成返回，其余回弹；时长取“剩余距离 / 速度”（速度下限 0.5 px/ms，90–340ms），和手指最后的速度连续；
- 手势进行中会话轮询（5s）、任务快照（2s）、列表轮询（5s）和秒表 tick 全部暂停，结束后补一次刷新（`isSwipeBackInFlight()`）——交互式转场期间不做后台重建，这是原生 App 的常规做法；
- 按下就加 `swipe-armed` 提升图层（`will-change: transform`），被盖住的目录从这时起恢复动画（`:has(.detail-screen.swipe-armed)`），`prefers-reduced-motion` 下直接切页不做动画；
- `tests/swipe-back.test.mjs` 覆盖阈值、锥角、进度、速度平滑和松手判定这些纯数学部分。

推送通知需要 APNs 设备注册和服务端推送链路，等前台闭环通过后单独实现。

## 公网服务器与 Mac 端

公网服务器负责 TLS 和字节转发，不理解会话、消息或工具调用。标准组件为：

- Nginx：监听 443，转发到 `127.0.0.1:18766`；
- FRP server：监听 `0.0.0.0:7000`，接收 Mac 主动建立的隧道；
- systemd：保证 Nginx、FRP 和证书续期常驻；
- 云安全组：放行 TCP `7000`；来源可先用 `0.0.0.0/0` 排障，稳定后收紧到 Mac 的公网 IP/32；
- 服务器系统防火墙：不需要开放 `18766`；
- 限流：对 `/remote/pairing/exchange` 设置严格请求速率；
- 日志：不记录 Authorization、配对码和二维码完整内容。

Mac 上的 Clash/TUN 等网络接管可能把 FRP 流量导向虚拟接口。启动 FRP 前应确认：

```bash
route -n get 47.97.24.242
nc -vz -G 5 47.97.24.242 7000
```

目标是使用真实网卡（通常为 `en0`），并能连通 TCP `7000`。FRP client 配置中的 token 必须与服务器一致；token 曾泄露时应重新生成并同时替换两端配置。

电脑端启动 adapter 时必须设置：

```bash
HAISH_REMOTE_PUBLIC_ENDPOINT=https://47.97.24.242 python3 -m server.app serve
```

桌面客户端从 loopback 调用 `POST /remote/pairing/start`，响应中的 `pairing_uri` 是二维码的唯一内容。

## GitHub Actions 与 SideStore 真机验证

仓库内的 `.github/workflows/build-ios-unsigned.yml` 是**唯一 IPA 构建入口**。它只允许手动触发，不使用 Apple ID、签名证书或仓库 Secret。工作流在 GitHub 托管的 macOS Runner 中执行完整的依赖安装、Web 构建、Capacitor 同步、iOS 编译、IPA 打包和 artifact 上传。

本地发布的禁止事项：

- 不要在开发 Mac 上运行 `xcodebuild`；
- 不要在开发 Mac 上执行 archive/export 或自行压缩 `Payload` 生成 IPA；
- 不要把本地 `dist/`、`ios/App/App/public/` 或旧 `.haish/artifacts/Haish-unsigned.ipa` 当作发布产物；
- 不要通过未推送的本地提交触发构建；GitHub Actions 只能构建 GitHub 上已经存在的提交。

标准流程：

1. 修改并测试移动端源码和文档；
2. 提交并推送到远端 `main` 分支；
3. 打开仓库的 **Actions** 页面；
4. 选择 **Build unsigned iOS IPA**，在 `main` 上点击 **Run workflow**；
5. 等待所有步骤成功，包括 `Build and sync Capacitor`、`Build unsigned iOS app`、`Package IPA` 和 `Upload IPA`；
6. 下载当前 run 的 artifact `Haish-unsigned-<commit>` 并解压得到 `Haish-unsigned.ipa`；
7. 将 IPA 导入 iPhone 的 SideStore；
8. SideStore 使用个人 Apple 账号签名并安装；
9. 在 iPhone 开启开发者模式，并在“VPN 与设备管理”中信任开发者；
10. 免费签名通常需要在有效期到期前由 SideStore 刷新。

artifact 是发布产物的唯一来源。安装前应确认 artifact 对应本次提交，而不是旧文件名相同的 IPA。SideStore 需要使用 Apple 账号完成个人签名，这是免费安装的必要条件；不要把 Apple 账号、密码、会话、证书或 provisioning profile 写入仓库及 GitHub Actions。

本地只允许执行以下同步检查：

```bash
npm test
npm run mobile:sync
```

`npm run mobile:sync` 只执行 Vite Web 构建、Capacitor 资源同步，以及把 App 内置原生插件登记进生成配置（`scripts/sync-ios-app-plugins.mjs`）；它不编译 iOS、不运行 Xcode、不生成 IPA。开发 Mac 只有 Command Line Tools、无法运行 `xcodebuild` 是预期状态，不是项目故障。需要验证可安装包时，必须回到 GitHub Actions。

## 验收标准

- `npm run build`、前端测试和服务端测试全部通过；
- `npm run mobile:sync` 能成功同步 Web 资源；
- GitHub Actions 能产出当前提交对应的 `Haish-unsigned-<commit>` artifact；
- artifact 内的 Web 资源包含当前源码的最新 UI，而不是旧的 `Scan your computer` 等文案；
- 未配对的 iOS App 只显示扫码入口；
- 非标准二维码、HTTP endpoint 和非法配对码均被拒绝；
- 首次扫码后能进入任务列表；
- 强制结束并重新打开 App 后无需再次扫码；
- Mac 或隧道离线时显示离线状态，恢复后自动同步；
- 点输入框左侧的图片按钮直接弹出半覆盖的“选择照片”面板（不再先出现 `Photo Library / Take Photo / Choose Files` 动作表），选完直接上传，按钮自动禁用满 4 张；
- 电脑端撤销设备后，手机下一次请求回到配对页；
- 公网入口通过 iOS 系统信任的 HTTPS 证书访问；
- 4G/5G 与电脑不同网络时可创建、继续、审批和停止任务。

## 当前状态

- GitHub Actions workflow：已配置为唯一 IPA 构建入口；
- 最新移动端 UI：已通过 Actions 成功构建并验证 artifact 内容；
- 公网 HTTPS：`https://47.97.24.242/remote/status` 已验证返回 `200`；
- FRP：服务器 `7000` 与 Mac client 隧道已验证可用；
- 本地 adapter：`127.0.0.1:8766` 正常；
- SideStore 真机安装：仍需在目标 iPhone 上执行；
- 签名：当前使用 SideStore 个人签名，不是 App Store/TestFlight 分发。
