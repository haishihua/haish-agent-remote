// 桌面的 shared/api/base.js 在**模块初始化**时读 `window.HAISH_API_BASE`（桌面端
// 是同源直链，值为空串）。手机的纯函数模块 import 了桌面模块（chat-runtime.js →
// task-runtime.js → workspace-state.js → base.js），node 里没有 window，所以凡是
// 直接或间接 import 到这些模块的单测，都要把这个壳放在最前面 import。
globalThis.window ||= {
  HAISH_API_BASE: '',
  location: { origin: 'http://localhost', protocol: 'http:' },
};
