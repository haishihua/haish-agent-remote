import React from 'react';
import { createRoot } from 'react-dom/client';
import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css';
import App from './App.jsx';
import { isNativeApp } from './native-connection.js';
import './styles.css';

// 原生 App 的标记：样式表靠它区分「WebView 的高度就是窗口」（键位不缩 WebView，见 ios-keyboard.js）
// 与浏览器的动态视口。写在渲染之前，第一帧就是对的。
if (isNativeApp) document.documentElement.classList.add('native-app');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
