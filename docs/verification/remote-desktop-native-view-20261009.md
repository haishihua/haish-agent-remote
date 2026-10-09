# 原生分辨率、大画面与自动连接提示 — 2026-10-09

## 实现

- 主显示器运行时测量：CoreGraphics display mode、采集图像都是 2940 × 1912 像素，逻辑点坐标 1470 × 956。高清档不再限制 1920 × 1080，直接编码当前主显示器原生采集尺寸；不修改系统显示模式，不拉伸或裁剪。网络质量自动适配仍可降到 1280 × 720 上限、15 fps（本屏为 1106 × 720）；恢复后重回原生、30 fps 目标。奇数像素仍向下对齐为偶数供 yuv420p。
- 默认视图放大 1.5×，HUD 可一键切到 1× 完整桌面，More 保留 1–3× 缩放；按视频实测比例和 ResizeObserver viewport 尺寸计算 fit，不让比例受 UI 布局拉伸。放大后可原生滚动平移。
- 解除远控页继承的 480px 宽度限制。竖屏视频由 37dvh/330px 上限增加为 48dvh/560px，手势面板缩至 130px。横屏左侧画面、右侧紧凑控件，展开模式固定覆盖 viewport 并收紧工具区。按钮禁用原生文本选择/长按菜单，横屏隐藏文案后仍有 aria-label。
- 正常连接使用 ICE `all` 自动路由，保留已有 TURN 凭据支持，但移除普通界面的 Force TURN 操作。连接成功时无“TURN 未配置”常驻警告；仅连接失败时解释缺少兜底的相关限制。没有新增/修改 TURN 或 VPN 配置，跨网络中继仍未验收。

## 已验证

- 109 项 Python、370 项 JS 回归通过，production build、Capacitor sync、bundled styles 与 diff whitespace 检查通过。
- 本机实际源码采集为 2940 × 1912；低质量为 1106 × 720。
- Chrome 模拟移动 viewport（非手机验收）：393 × 852、852 × 393，连接后无常驻警告、无页面异常；横屏 shell 使用完整 852px，普通/展开视频约 596 × 308 与 661 × 308。默认放大存在水平/垂直滚动范围；1× 完整模式无画面裁切滚动。平移、文本发送、More 和 Back 回调通过。
- 模拟布局使用受控 Peer 与旧的实际视频截图作为 poster，不作为新分辨率网络吞吐或真机效果证据。

## 构建与交付

源代码 `5592714c5d735ca011e82fd29af71a854b258463`；adapter Actions `37877586106` 成功。手机 toolbar accessibility 追加提交 `58e62e9bf4696dfa478fa99a74031ed3c6334ce5`，最终 iOS Actions `37877799950` 成功，下载 IPA 为 `tmp/ui-redesign/native-ipa/Haish-unsigned.ipa`，版本 **1.93/build93**，SHA256 `8a5883cfab6d9ce62f690e6a2ea6f98f788303fbadf6350cab5c2cc124c648d3`。包内确认包含新缩放 UI，且不含 Force TURN 操作文本。初始 iOS run `37877596463` 不作为最终安装包。

adapter 产物 SHA256 `83f0ae95c413d7f0d3e3fbd5880a8ce8344b4b1315522a0c90dff538480e2c62`，checksum 与签名验证通过。客户端 `Haish-agent/build/remote-adapter/haish-remote-adapter` 已原子替换，由客户端托管自动重启；备份同目录 `haish-remote-adapter.backup-before-native-5592714`。确认安装哈希一致，runtime 在线、隧道运行、远控保持开启、原有 3 个配对保留。桌面发布 lock 未修改，重新 fetch/打包可能覆盖本地二进制。

实际冻结 adapter WebRTC 解码收到 **2940 × 1912** 帧，尺寸断言通过，证据 `tmp/ui-redesign/native-rtp-1.png`。测试助手的光标固定位置像素断言失败（目标点采样为背景），不能算原生分辨率下光标位置验收通过；测试期间前台应用变化，随后读到实际光标位于主屏之外，存在本地并行操作，因此未继续移动鼠标重试。测试会话和临时配对已清理，原有配对 ID 集合不变；不把失败隐藏成通过。后续在无并行操作时复验光标。

本轮 `ios list` 暂无设备；手机包安装与真机验收必须在设备重新连接后执行。当前已知安装 build91 尚不包含这次 UI 和提示修改，不能宣称已生效。build93 已下载可供后续安装。
