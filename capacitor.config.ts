import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.haish.agent.remote',
  appName: 'Haish',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
    // 输入框直接贴着键盘：键盘弹出时按原生方式缩短 WebView（这就是插件默认值，写明在这里，插件默认值
    // 变了也能立刻看出来）。键盘上方那条系统表单栏（◀ ▶ Done）由 src/ios-keyboard.js 在启动时隐藏。
    Keyboard: {
      resize: 'native',
    },
  },
};

export default config;
