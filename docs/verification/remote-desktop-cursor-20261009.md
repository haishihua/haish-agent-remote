# 远控视频光标修复 — 2026-10-09

## 原因与修复

`CGDisplayCreateImage` 不包含系统光标，手机端也没有光标位置同步/叠加层。原验收只证明原生鼠标移动，未证明视频里可见。

现在在 adapter 的采集帧、编码前合成黑边白色箭头，热点取 `CGEventGetLocation` 的实际位置，映射 `CGDisplayBounds` 的全局点坐标到 Retina 采集像素。指针在视频降采样后仍保持可辨大小；裁剪不破坏行 padding，不把主屏外的位置强行画到主屏内。不新增远程坐标接口、不改变配对鉴权、前台租约或输入安全检查。

范围：当前仍只采集主显示器。显示的是实际位置的固定箭头，不是 App 专用 I-beam/resize 等系统指针形状；指针位于其他显示器时主屏视频不会伪造指针。

## 回归与本机采集验证

- 108 项 Python 测试通过，含新增 5 项光标位置/Retina、边缘裁剪、padding、非法及主屏外坐标、降采样可辨大小、编码前合成测试。
- 366 项 JavaScript 测试通过；`git diff --check` 通过。
- 实际主屏 bounds 1470 × 956，采集帧 1660 × 1080。移动到 `(808,382)` 后，视频帧约 `(912,431)` 处可见白色黑边箭头。
- 临时移动鼠标后已恢复原位置，未点击、输入或修改用户文档。
- 源码帧证据在忽略目录 `tmp/ui-redesign/cursor-source-frame.png`。

## 交付验证状态

源代码提交 `af8f828df497a589faf989030866feb111799e66`；GitHub Actions run `37872939078` 成功（含 CI 测试、冻结产物和隧道冒烟测试）。下载产物 SHA256 为 `72bb73738f283c68c41f0cbd06b370b1de4ed64d7548edf000153c2d89fa786d`，校验文件与 `codesign --verify --strict` 均通过。

客户端 `Haish-agent/build/remote-adapter/haish-remote-adapter` 已原子替换，旧产物备份为同目录 `haish-remote-adapter.backup-before-cursor-af8f828`。客户端托管进程自动重启后，确认安装文件哈希一致、runtime 在线、隧道运行、远控开启、屏幕录制和辅助功能权限正常。未修改桌面发布 lock；重新 fetch/打包可能覆盖该本地替换。

使用已安装冻结 adapter 的真实 WebRTC 连接验证，不以源码运行替代：收到 1660 × 1080 视频，在热点 `(580,377)` 与 `(1078,593)` 两处均确认黑边/白色填充经编码解码后存在，像素检查通过，人工查看两张帧图可见指针。证据 `tmp/ui-redesign/cursor-rtp-{1,2}.png`；测试助手 `tmp/ui-redesign/verify-cursor-video.py`。该助手只临时移动鼠标并恢复，不向用户 App 点击/输入。临时测试配对与会话已清理，原有 3 个配对 ID 集合不变；最终 `enabled:true, busy:false, runtime_online:true, tunnel.running:true`。

本轮 `ios list` 无设备，手机真机视觉/手势验收暂未执行，不以本机 WebRTC 视频或自动测试替代真机验收。手机包无需更新，修复完全位于 adapter。
