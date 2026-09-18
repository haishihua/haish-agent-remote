import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 手机端直接复用桌面的 chat 执行 UI（组件 + 样式都从 ../haish-agent 检出里 import，
// 见 src/desktop-theme.css 与 src/chat-view.jsx）。两件事必须在这里钉死：
//
// 1) dedupe：桌面文件里的裸导入默认按**它自己的** node_modules 解析，那样 react /
//    lucide-react / motion / streamdown 会在包里各来两份，React 两份就是
//    "Invalid hook call"。钉回手机这份，全树一份。（react/jsx-runtime 是 JSX 变换注入的，
//    也在另一份里，所以子路径同样要列。）
// 2) tailwind：桌面 agent-elements 的 CSS 用的是 v4 语法（@import "tailwindcss/utilities.css"
//    source(none)、@theme inline、@source "./*.tsx"、@reference），没有这个插件编译不过。
const desktopPackages = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  'lucide-react',
  'motion',
  'motion/react',
  '@floating-ui/react',
  'streamdown',
  '@streamdown/cjk',
  '@streamdown/code',
  '@streamdown/mermaid',
  'thinking-orbs',
  // markdown.css / elements.css 里 `@reference "tailwindcss/theme.css"`、
  // `@import "tailwindcss/utilities.css" source(none)` 也是从桌面文件出发解析的。
  'tailwindcss',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: desktopPackages },
  // 桌面文件在项目根之外，dev / preview 的静态服务要放行上一级目录。
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://127.0.0.1:8766',
      '/remote': 'http://127.0.0.1:8766',
    },
  },
});

