import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.haish.agent.remote',
  appName: 'Haish',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
    // 键盘不缩 WebView，也不改 body：插件在 iOS 上把这件事排在键盘动画之后（键盘动画时长 +0.2 秒
    // 当作延迟，然后一把 setFrame: 到位，见 ionic-team/capacitor-keyboard#79），现场就是键盘先到、
    // 输入框后到，收起时还会从缺口里闪出底下的界面。所以键位由 Web 层自己跟上：src/ios-keyboard.js
    // 在键盘落地时写 --keyboard-inset，动画期间只动合成层上的位移。
    Keyboard: {
      resize: 'none',
    },
  },
};

export default config;
