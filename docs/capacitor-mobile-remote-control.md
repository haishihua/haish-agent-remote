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

## 会话内的执行 UI 直接复用桌面 chat

用户看到的观感就是桌面客户端的 chat 模式：深灰胶囊 chip + 绿勾 + `Shell`/`Read` 短名、Terminal/CodeDiff/Search 工具卡、审批与提问卡、流式增量、ActivityOrb。手机不再自己折一套执行记录，也不再自己画工具卡。

**来源是 CI pin 的桌面检出**（`.github/workflows/build-ios-unsigned.yml` 里 `haishihua/haish-agent` 的 `ref`），不是子模块也不 `npm link`：

```text
桌面 0.0.20 = 97aaa54a359eabd4f2a225868df5e19aac8baf9e   # 当前 pin
```

### 手机侧的三个接缝

| 接缝 | 文件 | 干什么 |
| --- | --- | --- |
| 数据 | `src/chat-runtime.js` | 三条入口（详情/游标轮询、NDJSON 流、本地草稿）都折成**桌面形状**的 runtime task（`eventLog` + 记录字段），行由 `buildChatRows` 拼 |
| 视图 | `src/chat-view.jsx` | 直接渲染桌面 `ChatMessageRow` / `ChatAgentTimeline`；图片走 `api.imagePreview` 取字节 |
| 样式 | `src/desktop-theme.css` + `scripts/gen-desktop-base-css.mjs` | 引用桌面的 `styles/*.css`；生成的 `src/desktop-base.generated.css` 把桌面 `base.css` 的 `:root` token / `.ico-*` / portal tooltip 摘过来（已 gitignore，prebuild/predev 重生成） |

折叠用的原语全部来自桌面检出：`normalizeRuntimeEvent` → `runtimeEventToLog` → `appendStreamEvent` / `compactStreamEvents`（相邻 delta 合并成一条），时间线投影是桌面的 `buildChatTimeline(task, status)`。手机自己那套 `segments` 折叠、`TaskTrace` / `ToolTraceCard` 与它们的 `.tool-trace-*` 样式已删。

**不搬**：桌面 `ChatPanel`（拖 Lexical 输入框、ModelPickers、标注、搜索）、`createTaskStreamHandlers.js`（1003 行，接的是桌面的 socket 与 store）——手机只搬行、时间线、卡片和纯函数模型，composer / 目录 / 滚动仍是手机自己的。

### 手机上故意画得跟桌面不一样的三处

只有这三处，都是用户拍过的，其余一律照桌面：

1. **thinking 折叠 chip 不画**（桌面 `ChatTimelineNodes.jsx` 的 `.chat-timeline-thinking-*`：灯泡 + `N chars`）。用户说那是老 UI 的观感。事件日志照桌面折，只在 `chat-runtime.js` 交给行之前把 `kind === 'thinking'` 的节点滤掉——活动 orb 的文案仍走桌面那份（流式时它本来就在，只是少了一个可点的折叠块）。
2. **取消 / 失败任务的本地回复去重**（`withoutTimelineDuplicates`）。被 `cancel` 打断的那次回答没定稿，过程文本（commentary）已经是时间线上的一个节点，`answer_text` 又是同一段，正文整段去重就少一遍。只对这一种行生效：持久化消息的正文就是答案本身，done 行的时间线默认折着，去掉它就等于把答案藏起来。
3. **browser_use 的截图位降级成占位**。桌面靠 Electron IPC `readToolScreenshot` 读图，手机端 v1 不建 artifact 路由（core 只有会话图片预览，adapter 没有 artifact 通道）。卡片其余字段照搬。

另外 `src/main.jsx` 必须包一层桌面 `AppTooltipProvider`：行 / 时间线 / 工具卡里的 tooltip 会抛 `useContext must be used within GlobalTooltipProvider`，整条线程白屏。

### bump pin 的顺序

1. 在桌面检出里核一遍要 import 的符号在新 ref 上存在（import 任何 pin 之后才有的文件会**本地过、CI 挂**：CI 只 build、不跑测试，没有测试能发现这种漂移）；
2. 改 `.github/workflows/build-ios-unsigned.yml` 的 `ref`；
3. 本地三连：`node --test tests/*.test.mjs`、`npm run test:server`、`npm run build`（必须整跑——少一级 `..` 这类解析失败 `node --test` 看不见，只有 build 会报；`tests/desktop-imports.test.mjs` 把跨仓库 import 的路径也钉住）；
4. 重跑 `build-ios-unsigned.yml`。

> 桌面 `shared/api/base.js` 在**模块初始化**时读 `window.HAISH_API_BASE`，而 `chat-runtime.js → task-runtime.js → workspace-state.js → base.js` 这条链会被手机的纯函数模块拉进来。node 单测要先 `import './support/window-stub.mjs'`（见 `tests/support/window-stub.mjs`）。

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

agent 不参与还原，而是按“能不能换”决定是否锁：runtime 只会在会话的第一个被接受的 chat turn 上写死 agent 绑定（`set_agent_profile`），之后再带别的 `agent_id` 发任务一定 400（`Conversation is bound to agent X.`）。所以运行配置面板里的 agent 行只在会话还没发过消息时是可选项，新会话必须能选；判据与桌面端同一份规则（`src/agent-binding.js`）——会话自己的任务记录，或时间线里已经有用户消息，二者出现任意一个就锁；只上传图片（`POST /api/messages/images` 只存文件、不写消息）和还没被服务端接下的本机乐观消息都不算。

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
- 松手按速度决定去向：> 0.2 px/ms 就完成返回，否则看松手时过了半屏没有；只有明确往回（向左）甩（≤ −0.2 px/ms）才取消——手指离屏前回那一点点不算（以前要求速度不得为负，抬手指时的抖动就会把过了半屏的一划弹回去）；时长取“剩余距离 / 速度”（速度下限 0.5 px/ms，90–340ms），和手指最后的速度连续；收敛从“最后一帧真正画出来的进度”接上（不是手指的最新采样），快甩也不会在松手那一下跳一格；
- 手势进行中会话轮询（5s）、任务快照（2s）、列表轮询（5s）和秒表 tick 全部暂停；已经发出的请求如果在手势期间返回，会话刷新直接丢弃并在收敛后重取（`isSwipeBackInFlight()`）——交互式转场期间不做后台重建，这是原生 App 的常规做法；
- 详情页开着的时候目录轮询整个停掉：`/api/projects` 一份 ~3.5 MB，本机 `JSON.parse` + 签名 `JSON.stringify` 约 13ms，到手机上就是几十毫秒的主线程停顿，而且内容一旦有变化还会重绘被盖在下面的整份列表——这些在详情页都看不见，所以只在列表真正可见时轮询，返回列表时补一次刷新，且等一个空闲时机（`requestIdleCallback`）再拉，不压在滑动的最后几帧上。
- 按下就加 `swipe-armed` 提升图层（`will-change: transform`），收敛动画播完才摘掉（中途摘会让图层在动的时候重建，快甩的起飞段就会顿一下），`prefers-reduced-motion` 下直接切页不做动画；手指还按着时目录的定时动画全部冻着（`.app-shell.detail-open > :not(.detail-screen) *` 那条规则对拖动不开绿灯）：那是拖动期最重的一笔——手上正指挥着一个满屏图层时，把三只状态转圈和两条逐帧重绘的渐变放回来，既要重算整份被盖住的列表的样式，又要每帧再画一遍它们。松手那一下（`.detail-screen.swipe-dismissing`）就放回来：从那一刻起被揭开的是目录本身，正在走的是自己往外飞的详情层，原生滑退里被揭开的那一层从来不是冻着的；等到收尾之后才恢复，看到的就是目录先冻几十毫秒、再连着恢复的代价一起跳一下（用户报的「能返回，但收尾卡/跳」）。详情页自己那两条渐变也一起暂停（`.detail-screen.swipe-armed .agent-phase-gradient`），理由同上；
- 目录顶栏那层 `backdrop-filter`（`--topbar-backdrop`）在详情页开着时置 `none`（`.app-shell.detail-open .remote-topbar`）：没键盘、没列表滚动时它是免费的，但 iOS 会在它上面每一帧重算一次背景模糊——手指还在拖的时候正好有一个满屏图层从它上面走过，模糊得跟着重算，拖动就会一卡一卡；详情开着时它本来就被盖住，关了不丢任何东西。松手那一下（同样按 `swipe-dismissing` 那两条 `:has` 规则）就放回来：整屏背景模糊的第一次渲染如果攒到收尾动画之后，那一帧正好是目录刚刚露全、眼睛盯着的地方。
- 收尾那一帧不许再塞重活。滑退动画走到头时同时来了三笔：React 卸掉整棵详情树（连同它一串 effect 清理）、目录几十个定时动画重新交给合成器、顶栏第一次渲染 `backdrop-filter`（一整屏背景模糊）。后两笔现在挪到了松手那一刻（见上面两条 `:has` 规则），`src/dismiss-handoff.js` 只管把卸层排到「动画最后那一帧已经画出去」之后（两个 `raf`）；滑退那条路不挂 `html.detail-closing`（`dismiss({ hold: false })`，目录在松手时已经活了、再冻两帧只会看到跳一下），按钮返回那条路没动画，仍然靠它把恢复推到卸层之后。目录本身套了 `React.memo`，`openConversation / createConversation / showSettings` 都过 `useCallback`——开、关会话都要重渲染整页，而目录此时正压在详情层下面，那十几毫秒（每行都要重算预览、分组、排序）就落在收尾那几帧上；
- `tests/swipe-back.test.mjs` 覆盖阈值、锥角、进度、速度平滑和松手判定这些纯数学部分，`tests/dismiss-handoff.test.mjs` 覆盖上面这套帧交接的次序、`hold: false`（滑退那条路）与两条 `:has` 规则是否还在 `styles.css` 里（`raf` 注入）。

### 加载失败与下拉刷新

列表和详情的加载失败都是死路：头上一条错误横幅，下面却什么都没有（列表还会误显示成“No conversations yet”，详情只剩一个转圈）。两处都接了同一套下拉刷新：纯数学与手势标志在 `src/pull-to-refresh.js`，组件里由 `usePullToRefresh` 装配，做法与右滑返回一致：

- 只有从顶部按下（列表是页面滚到 0，详情是消息区滚到 0）、位移过 6px 且方向落在竖直轴 40° 锥角内才认领手势；横滑（含右滑返回）和向上滚动的拖动照旧归滚动容器；
- 内容跟手移动（位移 ×0.55，封顶 112px），指示器固定在“表面”第一个像素上方，随下拉从头部下面滑出来并按进度旋转，和原生刷新控件一样；
- 松手过 64px 才真的刷新，其余回弹；刷新期间内容停在 56px、指示器持续旋转，最短 420ms（请求再快也不闪一下），手势与刷新期间 5s 轮询照旧暂停、结束后补一次；
- 加载失败时列表与详情各显示一张卡片（`Couldn’t load …` + `Pull down to try again.`），真实错误仍然只由顶部横幅承载；这张卡片会一直留到那次加载真的成功为止——`/remote/status` 的轮询自己会成功，以前它顺手把目录的错误也清掉了，于是列表失败几秒后会变成“No conversations yet”，连可以下拉的失败态都没了。

### 键盘：跟输入框一起上来，一起下去

WKWebView 里的输入框获得焦点时，iOS 会在键盘上方压一条系统表单栏（左侧「◀ ▶」翻表单项、右侧 `Done` 收键盘）。它不属于本 App，却在输入框和键盘之间白占 44pt：启动时 `src/ios-keyboard.js` 调一次 `Keyboard.setAccessoryBarVisible({ isVisible: false })` 关掉它；调用失败会走启动错误路径，不静默留着。

键盘本身则不能交给插件去缩 WebView。`Keyboard.resize = native`（插件默认值）在 iOS 上把这件事排在键盘动画之后：`onKeyboardWillShow:` 把键盘动画时长 +0.2 秒当作*延迟*，到点才一把 `setFrame:` 到位，前后没有任何动画（ionic-team/capacitor-keyboard#79）。现场因此是两个毛病：弹出时键盘先升起来、压在还没让位的输入框上，约 0.4s 后整页跳一下；收起时 frame 先弹回全高，页面还停在缩短的高度，底下的会话列表从缺口里露出来闪一下——`.detail-screen` 那份 `height: 100dvh` 还让这一帧更明显（高度写死成 dvh 值，视口变化时它比 `inset: 0` 晚，晚的这一帧就是列表）。

所以 `capacitor.config.ts` 里写明 `Keyboard.resize = 'none'`，键位由 Web 层自己跟（`src/ios-keyboard.js`）：

- `keyboardWillShow / DidShow / WillHide / DidHide` 四个事件驱动一个控制器（浏览器里一个监听都不注册）。展开时按「键盘落地那一刻」要占的高度算，收起时回 0；
- 布局只在一件事上听键盘的：键盘落地后给 `:root` 写一次 `--keyboard-inset`（插件报的就是键盘 frame 的高度，已包含它盖住的底部安全区）与 `--keyboard-lift`。`body` 用它给目录页留出把最后一行滑到键盘上方的空间，`.detail-screen` 用它把输入框抬到键盘上沿上方那段呼吸位（`.composer-dock` 的底部安全区边距同时收成那一段），`.message-region` 用它向上多长一段；
- 运动期间布局一个字节都不写：消息列表与输入框按合成层上的 transform 跟键盘一起走，时长与曲线取 iOS 自己的，理由与右滑返回、下拉刷新一样——逐帧写样式会把整份消息列表算一遍，而这个 App 的主线程经常有活干。时长来自键盘通知里的 `UIKeyboardAnimationDurationUserInfoKey`（秒，由下面那条 frame 通道一并带来；缺失或离谱就沿用上一把键盘的值，插件那四个事件里没有这个值）。曲线不是随便挑一条缓出：iOS 系统键盘用的是 curve 7，那是临界阻尼弹簧，归一化后 `x(u) = (1 - (1 + 7u)·e^-7u) / (1 - 8e^-7)`；1.40 之前写死的 `cubic-bezier(0.32, 0.72, 0, 1)` 在开头抢跑（u = 0.2 时已经走完 0.245 行程，350pt 的键盘就是 86pt），键盘还在慢慢地升、输入框已经到顶了——用户说的「僵硬」就是这一段（假设，等真机复验）。现在认 `linear()` 的 WebKit 直接用按这条弹簧采样出来的停靠序列（`KEYBOARD_MOTION_EASING`），不认的退回同形状的 `cubic-bezier(0.3, 0.35, 0.15, 1)`（拟合误差 0.018），两条都不落回 `linear`；
- 只有读者贴着底端（`keyboardFollowing`）时消息列表才跟着走：翻上去看历史时键盘只是盖住列表下缘，内容留在原处，走的只有输入框（那是让开键盘，与看的是哪一段无关）。这条对应 RN 生态里那个键盘库 `react-native-keyboard-controller` 的 `keyboardLiftBehavior`：`whenAtEnd`（它标的就是 ChatGPT）、`always`（Telegram / WhatsApp）、`persistent`（Claude）、`never`（Perplexity），我们取第一个；
- 落地事件一到就换手：写 `--keyboard-inset` 与 `--keyboard-lift`、清掉 transform、把消息列表贴回底部在同一个任务里完成，描述的是同一批像素，所以看不见；贴底不等 `ScrollToBottomButton` 的 ResizeObserver（它要等到这一帧的渲染步骤才跑，画面不该靠那一步与清 transform 的先后），控制器自己写同一个落点，它随后那次吸底就是同一件事（读者已经翻上去看历史时两边都不动，用的是同一条“贴着底”判断）；
- 消息列表那两块不是各自找位置：列表的“窗口”（`.message-region` 的裁剪框）和输入框同一批位移、同一个时长，列表连窗口带内容一起动。上一版只把滚动内容 translate、窗口不动，收起键盘时内容整块滑出自己的裁剪框，整片区域露出页面底色——用户报的就是这一下；
- `--keyboard-lift` 是键盘抬着的时候消息列表向上多长的一段（负的 `margin-top`）：收起的那一段里窗口上沿跟着往下走，多出来的这段让上面的历史消息留在窗口里（原生收起键盘时窗口是向上长的，看到的就是这些历史），而不是留一条空白。它和 `.detail-screen` 的 padding-bottom 在列表的可见高度上正好抵消，所以落地换手时滚动位置一个字都不用改；
- 输入框那一叠停在哪儿由两行管：`.detail-screen` 的 padding-bottom 把它抬起来，`.composer-dock` 自己的 `8px + 安全区` 底边距同时收掉，但不是收到 0——`max(12px, ... - var(--keyboard-inset))`，收完还留 12pt（`KEYBOARD_DOCK_GAP`，照用户给的参考图量的，输入框两侧本来就留 10px），输入框是浮在键盘上方而不是长在键盘上。总上移量因此是“键盘高 + 呼吸位 − 静息空隙”（`keyboardLift`；量不到安全区时退化成键盘高 + 12；键盘比静息空隙还矮时不动）。两处描述的是同一个像素位置，`tests/ios-keyboard.test.mjs` 里有一条按这个公式遍历屏幕高 / 键盘高 / 安全区的不变量在看着；
- 快速开合会打断上一段动画：每次都从当前计算值接着走（`translateYOf`）；事件丢一个也由落地事件补上（`keyboardDidShow / DidHide` 自带高度）；插件把「只多一条 QuickType 提示栏」报成高度 0，那不算收起；
- 插件在每个键盘事件里都会把 WebView 的 `contentInset` 归零（`resetScrollView`），iOS 那套替你挪一下的补偿不会叠在上面，让位的高度始终只有 `--keyboard-inset` 这一份；但归零的只有 `contentInset`，`contentOffset` 没人管：输入框获得焦点时 WKWebView 自己会把整篇文档往上顶一下，键盘收起后那一段就留在画面里（顶上是页头、底下露一片页面底色），也就是用户报的「短暂黑屏」。两个落地事件里各把 `window.scrollY / scrollX` 按回 0 一次（`pinDocumentOffset`）：整页是个 `inset: 0` 的固定壳，文档本来就不该滚动（滚动都在 `.message-scroll`、目录那些内层容器里），没被顶走时一次也不碰；
- 收起键盘时布局要在**动画开始前**就换成「抬着」的状态。1.36 是等落地才写 `--keyboard-lift`，碰上「上一次抬起时读者没贴底（布局里没抬）、这次贴底（列表要跟着动画）」这个组合：列表整块往下滑 `lift` 那段，而布局里那段负 margin 还是 0，页头下面于是就露出一条键盘高、纯黑的缺口（用户反馈里的「短暂黑屏」，截图里最后一张卡片下方近 1000px 只有页面底色）。现在改成：这种配平在收起一开始就写掉，同一个任务里用滚动把内容按回原位（画面不动）；其余情况下布局在运动期间仍然一个字节不写；
- 键盘抬着的时候高度又变了一次（换输入法、切 emoji、系统键盘上多一条提示栏）：这一趟要走的位移是**新旧高度之差**，不是整个上移量。布局里已经抬着上一把键盘的那一段，再补一整段就等于把输入框甩到键盘上方一整段——用户报的「切换键盘，输入框又往上跑」。配平那条规则也按同一个差值看：只有往下走、且布局里没抬够时才在动画开始前把 `--keyboard-lift` 换过去；落地时 `--keyboard-lift` 也按新高度重算（1.38 之前取的是新旧高度里大的那个，换成矮键盘后会多留一段窗口）；
- 换键盘在 iOS 上常常只发 `UIKeyboardWillChangeFrameNotification`，不发 `will/didShow`：Capacitor 的 Keyboard 插件只订阅后两者，这种时候它一声不响（现场截图里输入框就停在上一把键盘的高度上——键盘与输入框之间一整片页面底色，约 100pt）。所以 `ios/App/App/AppDelegate.swift` 另挂一个 `keyboardWillChangeFrame` 观察者，把键盘在屏幕上真正盖住的高度（点；键盘挪出屏幕时为 0）和这一趟的动画时长（秒，`UIKeyboardAnimationDurationUserInfoKey`）用 `window.dispatchEvent(new CustomEvent('haishKeyboardFrame', { detail: { height, duration } }))` 转给 Web 层，`src/ios-keyboard.js` 收到后走同一套逻辑（0 等于收起）。原生那一侧只报这两个数、不碰布局；事件用 `eval` 自己发，不走 `bridge.triggerWindowJSEvent`——Capacitor 8 的 JS 侧已经没有 `Capacitor.triggerEvent`（只剩类型声明），那条路只会变成一次没人看的 JS 报错；构建那一步会分别到包里的二进制和 JS bundle 里找这个名字，确认这条通道的两端都在包里（`height` / `duration` 这两个名字两端必须一致，改名要一起改）；
- 答案框这类落在消息列表内部的输入框，浏览器自己那次滚动发生在布局挪动之前，落地后再把它拉回输入框上方一次。
- 展开态的输入框不再钉死 82px：`src/composer-height.js` 按内容算高度，夹在 CSS 的 `min-height: 48px` / `max-height: 132px` 之间。短草稿不再留一条空白（单行 121px → 之前 155px 的整个盒子），长草稿长到 132px 才在框内滚动；上下限仍然只在 `src/styles.css` 的 `.composer textarea` 里定义一份。重量时机见下面《主线程上的三笔活》——打字那条路不再每键走一遍 `auto`。`.detail-screen` 只在浏览器（`html:not(.native-app)`）里写 `height: 100dvh`，免得 PWA 里被地址栏遮住；App 里靠 `inset: 0`。

### 主线程上的三笔活：打字、轮询、流式

会话最大的一份是 1.7MB（396 条消息、约 1.4 万个 DOM 节点）。在这样一页上，笔笔后台活都得从主线程过，所以三处的做法都是“先问一下真的变了吗”，而且手势与键盘动画期间一律让路：

- **打字**：`fitComposerTextarea` 原来每个按键都走「写 `height: auto`（把整页布局打脏）→ 读 `scrollHeight`（当场把它算回来）→ 写回高度」，一页几千个节点时一次就是几十毫秒——真机上的「打字不跟手」就是它。现在分三条路：草稿没变就直接返回上次的结果（连 `scrollHeight` 都不读）；草稿变长不写 `auto`，只读一次 `scrollHeight`，没变高连 CSS 都不写（写样式同样让布局失效）；只有草稿变短、或调用方标了 `force`（进入展开态、旋转屏幕、右侧配置图标出现/收起）才走完整的那一趟。上下限是样式表里的 px 常量，每个元素只读一次（`getComputedStyle` 也不便宜）；
- **轮询**：目录与详情以前都是 5 秒重拉一次，现在的节奏是状态与审批 5 秒、目录 15 秒、详情 15 秒；而且拿回来的东西先过一道“画出来的字段有没有变”的签名（`src/poll-signature.js`，字段是照着 `src/App.jsx` 里真读的那些列的；`device.last_seen_at` 这种服务端每次鉴权都刷新的故意不比），一样就不写 state——写下去就是整棵详情树重渲染一次，而这轮多半什么都没带回来。手势（右滑、下拉）与键盘动画期间整圈跳过，检查点有两个（`fetch` 之前与拿回来之后），结束后由原来的补拉逻辑补一次；
- **流式**：回答是一串很密的 token 事件，一条一条 `setState` 就是每几个字把整页重渲染一次。现在事件先折进 `liveRunRef`，每帧最多往 React 递一次（`scheduleLiveRun`）；任务落地（成功/失败/取消）用 `flushLiveRun` 立刻写下去，最后一帧不会留在动画里。键盘正在动这件事由一个模块级标志报出来（`isKeyboardMoving`，由键盘控制器在动画起飞/落地时维护），它与右滑、下拉两个标志并排成 `threadBusy`，秒表 tick、任务快照、状态轮询都走同一个判断。

三处都只动本仓库：`src/composer-height.js`、`src/poll-signature.js`、`src/App.jsx`（轮询节奏与守卫在调用点，不改桌面仓）。限速测量（Chromium + 4 倍 CPU）里这三笔分别对应每键约 85ms、空闲每 5 秒一次 97–110ms 的长任务、流式期间每 token 一次重渲染；真机手感仍由用户复验。

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
- 会话内执行 UI：直接渲染桌面 chat 的行 / 时间线 / 工具卡 / 审批与提问卡（pin 桌面 0.0.20，见上文「会话内的执行 UI 直接复用桌面 chat」）；
- 最新移动端 UI：已通过 Actions 成功构建并验证 artifact 内容；
- 公网 HTTPS：`https://47.97.24.242/remote/status` 已验证返回 `200`；
- FRP：服务器 `7000` 与 Mac client 隧道已验证可用；
- 本地 adapter：`127.0.0.1:8766` 正常；
- SideStore 真机安装：仍需在目标 iPhone 上执行；
- 签名：当前使用 SideStore 个人签名，不是 App Store/TestFlight 分发。
