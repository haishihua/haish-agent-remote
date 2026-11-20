# Mobile full-width answers — 1.102

## 1.105 真机后续验收

- Actions `44692121169` 成功，应用源提交 `0851b6a4a8c06dd5ef7f2bddf514197c0ce7a295`；回归测试提交 `cd2bd42`。
- 重启卡住的 Sideloadly 后完成覆盖安装；安装工具显示 `Done. 100%`，设备 `ios apps --list` 独立确认 `Haish 1.105`。首次 WDA 启动曾因安装中/签名状态被拒绝；安装完成后通过主屏图标成功启动应用。
- 使用已有会话“设置列表删除入口改为左滑删除”，未发送消息、Retry 或触发模型任务。
- 真机确认 Agent 身份头像/名称隐藏，耗时 `1m 06s` 和展开箭头位于左侧；原用户蓝色消息气泡和 composer 保持原样。
- 时间线展开显示真实执行前言及工具汇总 `read 8 files · searched 5 times · used browser 2 tools`；继续展开汇总，出现 List dir、Glob files、Browser use、Search text、Read 及文件路径、成功状态。
- 展开 Browser use 卡，出现 Browser 面板及 Code/Output 子区；展开 Code，显示该历史调用真实代码 `goto_url('https://dissolve.rselmi.com/#/swipe-to-delete')` 与 `print(page_info())`。并非将最终回答文本作为工具卡替代。
- 时间线完成收起/再次展开，工具汇总仍存在。Markdown 标题、加粗、表格及行内代码实际渲染；`SettingsRow`、`onDelete` 为浅色字，不再是手机独有黄色。样式与复用的客户端组件规则一致；未做所有 Markdown 语法逐像素对照。
- 截图：`/tmp/haish105-launch.png`、`/tmp/haish105-top.png`、`/tmp/haish105-expanded.png`、`/tmp/haish105-toolgroup.png`、`/tmp/haish105-browser-card.png`、`/tmp/haish105-card-content.png`、`/tmp/haish105-reexpanded.png`。
- 根因修复：与当前客户端 restore 一致，`event_view=runtime` 响应标记 `truncated` 时回读 `event_view=full`，避免将缺少早期工具事件的快照当成完整时间线。API 17 项及新增完整历史回退 2 项测试通过；此记录另提供独立真机渲染证据。


- Source: `4f6e5b9380bbc7ed55817d25d29c57eb29fb6f20`; only mobile `src/styles.css` changed.
- Actions run `44687116590`, build 102 succeeded, including Web/native builds and packaged style/plugin checks.
- Downloaded IPA Info.plist: version 1.102 / build 102. SHA256: `66ef8c11ebfdc6422f3c1f9708fc7605efa45f79b1cc3d835e7faaded4c0fc1c`.
- Device app listing independently confirmed Haish 1.102. User completed Sideloadly installation after native UI observation timed out.
- WDA recovered using explicit XCTest selector `UITestingUITests/testRunner` and a fresh USB forward from host 18200 to device 8100. Old forwards reset connections. WDA returned ready and created a Haish session.
- Real iPhone iOS 17.5.1, 393pt portrait: opened the existing book-analysis conversation using WDA tap. Captured actual app screenshots, inspected answer beginning, middle (lists/inline code/code block), and end.
- Confirmed assistant answer has no outer bubble, starts at page margin (16pt), and spans available 361pt width. Agent avatar/name/duration retained above body. User message retains blue bubble, avatar, timestamp and copy action. Composer retains its existing design.
- WDA swipe navigated a long existing answer from end through middle to initial user prompt. Headings, lists, quote, and code block retained their internal styling. End-of-answer paragraph and copy/time are accessible above composer. No model call, retry, or task submission performed.
- Temporary screenshots: `/tmp/haish102-answer.png`, `/tmp/haish102-scroll2.png`, `/tmp/haish102-user.png`.
- Scope limitation: this verifies persisted long-answer layout and actual scrolling, not a newly generated streaming answer, landscape, or every Markdown fixture. One duration-based drag selected text; selection was dismissed and scrolling validated using WDA swipe instead.
- Local build and chat-runtime test could not resolve shared desktop modules because adjacent desktop checkout differs from CI's pinned source. CI build with pinned source succeeded; local Retry contract tests passed (3), `git diff --check` passed.
