import React from 'react';
import { createRoot } from 'react-dom/client';
import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css';
import App from './App.jsx';
import { api } from './api.js';
import { installHaishBridge } from './haish-bridge.js';
import { isNativeApp } from './native-connection.js';
// 桌面的行 / 时间线 / 工具卡里有 animate-ui 的 tooltip，它要求外面有
// TooltipProvider（桌面的 app.jsx 也是这么包的）。Provider 放在这里而不是会话
// 线程里：tooltip 的浮层就画在 Provider 那层，套在 `.message-scroll` 里会多出
// 一个 flex 子元素。
import { AppTooltipProvider } from '../../haish-agent/app-web/src/shared/ui/PortalTooltip.jsx';
import './styles.css';

// 原生 App 的标记：样式表靠它区分「WebView 的高度就是窗口」（键位不缩 WebView，见 ios-keyboard.js）
// 与浏览器的动态视口。写在渲染之前，第一帧就是对的。
if (isNativeApp) document.documentElement.classList.add('native-app');

// `window.haish` 的接缝要在渲染之前装好：桌面的审批 / 提问 / 浏览器安装卡挂载时就会订阅
// （approval-store.js 的 ensureStream），晚一步它们只会 warn 一句、之后再也不收事件。
// 桌面那套由 Electron 主进程转发 runtime 的 WebSocket，手机上换成 App 的 5s 快照轮询
// 与适配器的三个 resolve 端点（见 src/haish-bridge.js）。
installHaishBridge({ api });

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppTooltipProvider>
      <App />
    </AppTooltipProvider>
  </React.StrictMode>,
);
