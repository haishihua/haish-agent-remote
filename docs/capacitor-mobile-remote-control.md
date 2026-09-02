# Haish 移动端远程控制方案

## 结论

移动端继续使用当前仓库中的 React 界面，通过 Capacitor 生成 iOS 原生工程；以后在同一仓库增加 Android 工程。业务 UI、任务模型和 API 客户端只有一份，不创建独立 SwiftUI、Android 或移动端仓库。

第一阶段由 GitHub Actions 在 macOS Runner 上构建未签名 IPA，再由 iPhone 上的 SideStore 使用个人 Apple 账号签名安装。开发电脑不安装完整 Xcode。App Store、TestFlight、推送通知和多用户服务不在本阶段范围内。

## 唯一运行链路

```text
iOS App（React + Capacitor）
        │ HTTPS + Bearer device token
        ▼
https://47.97.24.242
        │ Nginx + FRP server
        ▼
Mac 上的 FRP client
        │ loopback
        ▼
Haish Remote adapter（127.0.0.1:8766）
        │ strict API allowlist
        ▼
Haish Agent runtime（127.0.0.1）
```

公网入口必须使用受系统信任的 HTTPS 证书。iOS 不允许 HTTP、自签名证书或关闭 ATS 的兼容路径。`47.97.24.242` 当前只有 HTTP，完成公网部署后才可用于真机连接。

## 仓库结构

```text
haish-agent-remote/
├── src/                    # Web、iOS、Android 共用 React 代码
├── server/                 # 只运行在 Mac，不打入手机包
├── tests/                  # 共用协议和 API 测试
├── docs/                   # 架构与部署文档
├── capacitor.config.ts     # Capacitor 唯一配置
├── ios/                    # Xcode 工程，提交并维护
└── android/                # 后续通过 Capacitor 增加
```

Capacitor 只把 Vite 的 `dist/` 复制进原生应用。Python 服务和 Haish runtime 始终留在电脑端。

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

推送通知需要 APNs 设备注册和服务端推送链路，等前台闭环通过后单独实现。

## 公网服务器

公网服务器负责 TLS 和字节转发，不理解会话、消息或工具调用。标准组件为：

- Nginx：监听 443，安装 `47.97.24.242` 的受信任 IP 地址证书；
- FRP server：接收 Mac 主动建立的加密隧道；
- systemd：保证 Nginx、FRP 和证书续期常驻；
- 防火墙：只开放 SSH、80/443 和 FRP 控制端口；
- 限流：对 `/remote/pairing/exchange` 设置严格请求速率；
- 日志：不记录 Authorization、配对码和二维码完整内容。

Haish Remote adapter 和 Agent runtime 都必须继续绑定 `127.0.0.1`，不得直接监听公网网卡。

电脑端启动 adapter 时必须设置：

```bash
HAISH_REMOTE_PUBLIC_ENDPOINT=https://47.97.24.242 python3 -m server.app serve
```

桌面客户端从 loopback 调用 `POST /remote/pairing/start`，响应中的 `pairing_uri` 是二维码的唯一内容。

## GitHub Actions 与 SideStore 真机验证

仓库内的 `.github/workflows/build-ios-unsigned.yml` 是唯一 iOS 构建入口。它只允许手动触发，不使用 Apple ID、签名证书或仓库 Secret。Remote UI 复用的桌面客户端模型和图标由 CI 从公开的 `haishihua/haish-agent` 仓库检出，并固定到已验证提交，避免云端构建依赖开发电脑目录或跟随 `master` 漂移：

1. 将本仓库推送到 GitHub；
2. 在仓库的 Actions 页面选择 `Build unsigned iOS IPA`；
3. 点击 `Run workflow`；
4. 构建完成后下载 `Haish-unsigned-<commit>` artifact 并解压；
5. 在 iPhone 的 SideStore 中导入 `Haish-unsigned.ipa`；
6. SideStore 使用个人开发证书签名并安装，Haish 随后出现在手机桌面；
7. 在 iPhone 开启开发者模式，并在“VPN 与设备管理”中信任开发者；
8. 免费签名有效期为七天，SideStore 必须在到期前刷新。

SideStore 需要使用 Apple 账号完成个人签名，这是免费安装的必要条件。不要把 Apple 账号、密码、会话、证书或 provisioning profile 写入仓库及 GitHub Actions。正式稳定分发时改为付费 Apple Developer 账号和 TestFlight，不改变 React/Capacitor 代码结构。

## 验收标准

- `npm run build`、前端测试和服务端测试全部通过；
- Capacitor 能成功同步 Web 资源并生成 iOS 工程；
- GitHub Actions 能产出可由 SideStore 导入的 `Haish-unsigned.ipa`；
- 未配对的 iOS App 只显示扫码入口；
- 非标准二维码、HTTP endpoint 和非法配对码均被拒绝；
- 首次扫码后能进入任务列表；
- 强制结束并重新打开 App 后无需再次扫码；
- Mac 或隧道离线时显示离线状态，恢复后自动同步；
- 电脑端撤销设备后，手机下一次请求回到配对页；
- 公网入口通过 iOS 系统信任的 HTTPS 证书访问；
- 4G/5G 与电脑不同网络时可创建、继续、审批和停止任务。

## 当前外部阻塞

- 当前目录还不是 Git 仓库，工作流需要先推送到 GitHub 才能实际运行；
- SideStore 尚未在目标 iPhone 上配置，因此还不能完成真机安装；
- `47.97.24.242` 的 80 端口已有 Nginx，但 443 当前不可用；
- 当前 SSH 身份无法登录该服务器，部署 HTTPS 与 FRP 前需要有效的 SSH 用户和认证方式。
