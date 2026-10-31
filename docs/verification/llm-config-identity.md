# Remote 配置身份恢复回归

## 本轮修复

- 以 `request_llm_config_id` / `request_options.llm_config_id` 识别配置记录；同 Provider、同模型不能合并 API Key 与 OAuth 身份。
- 会话当前只读 `run-config` 优先于历史任务及旧手机缓存；发送和 Retry 前重新读取当前路由。当前屏幕里的手动选择有独立标记，不被异步读取覆盖，接单后回到服务端权威恢复。
- 有明确身份但记录已删除、当前配置缺少身份或模型时，保留不可用状态并拒绝发送，不借用其它记录。
- 普通发送、Retry 和模型目录请求携带 `llm_config_id`；adapter 为旧手机补充 legacy 身份别名，Retry 白名单保留现代 ID、显式 null 和冲突输入交由 core 校验。
- 仅增加 GET run-config 转发；没有开放会话配置 PUT 或 settings/llm 写权限。
- adapter 版本准备为 0.2.4；手机 UI 不包含在 adapter 冻结产物内。

## 本地验证

- `node --test tests/*.test.mjs`：412/412 通过。
- `.venv-desktop/bin/python` 全量 unittest discovery：129 项通过；导入 app 前以临时目录设置 `HAISH_REMOTE_DATA_DIR`。
- `npm run build`：通过。存在当前桌面网页依赖的 BrowserRuntimeCard 非导出警告与 bundle size 警告，本轮未扩修。
- `node --check src/run-config.js`、`node --check src/api.js`、`git diff --check`：通过。
- 跨仓库离线回放调用生产 core task summary、adapter 身份别名、remote restore/API 序列化、adapter realtime bridge、core merge/prepare：普通发送与 Retry 都保持 OAuth ID + 非默认模型；起点包含错误 API 缓存，core 合并起点包含另一个 API 路由。
- 假 HTTP/WebSocket transport 与临时目录隔离：未向真实 runtime 提交任务，未调用真实模型，未修改真实认证、LLM 设置或会话数据。

## 交付边界

本地回归不能证明历史切换的客户端来源，也不证明手机已安装本轮代码。替换 adapter 只能更新 adapter 的兼容层；旧手机若显式发送缓存中的 API 配置，adapter 不会擅自改写为 OAuth。

此记录形成时，Actions 构建、下载校验、实际二进制替换及重启验收尚未执行。发布必须使用 `build-remote-adapter.yml` 产物，不使用本地冻结包。
