import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 手机端直接复用桌面的 chat 执行 UI（组件 + 样式都从 ../haish-agent 检出里 import，
// 见 src/desktop-theme.css 与 src/chat-view.jsx）。两件事必须在这里钉死：
//
// 1) dedupe：桌面文件里的裸导入默认按**它自己的** node_modules 解析，那样 react /
//    lucide-react / motion / streamdown 会在包里各来两份，React 两份就是
//    "Invalid hook call"。钉回手机这份，全树一份。（react/jsx-runtime 是 JSX 变换注入的，
//    也在另一份里，所以子路径同样要列。）
// 2) tailwind：桌面 agent-elements 的 CSS 用的是 v4 语法（@import "tailwindcss/utilities.css"
//    source(none)、@theme inline、@source "./*.tsx"、@reference），没有这个插件编译不过。
//    **而桌面 markdown.css 的 @source 指向桌面仓库的 node_modules**（Streamdown 四份包），
//    CI 里桌面只 checkout 源码、不装依赖，扫不到就等于表格 / 代码块的工具类整段消失——
//    本地看不出来。所以那份样式由 scripts/gen-desktop-markdown-css.mjs 复制一份改过
//    @source 起点的副本，下面的 desktopMarkdownSeam 插件把桌面的路径指过去（只编译一份，
//    见那个脚本的注释）。
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

// 生成物在 src/ 下（prebuild/predev 重生成，见 .gitignore）。
const desktopMarkdownCss = fileURLToPath(new URL('./src/desktop-markdown.generated.css', import.meta.url));
const desktopMarkdownComponent = path.join('haish-agent', 'app-web', 'src', 'shared', 'ui', 'Markdown.jsx');
const mobileMarkdownComponent = fileURLToPath(new URL('./src/mobile-markdown.jsx', import.meta.url));

/**
 * 桌面 markdown.css 的接缝：桌面那份里的 @source 指的是**桌面仓库**的 node_modules
 * （Streamdown 四份包），CI 里桌面只 checkout 源码、不装依赖，Tailwind 扫不到类名，
 * 表格 / 代码块要用的工具类整段消失（本地看不出来）。这里把桌面那个路径换成生成的副本。
 *
 * 用 resolveId 而不是 resolve.alias：实测 alias 拦不住桌面 Markdown.jsx 里那句相对
 * import（`../../../styles/markdown.css`）解析出来的绝对路径，还是把桌面原件编进去了。
 */
function desktopMarkdownSeam() {
  const desktopSuffix = path.join('haish-agent', 'app-web', 'styles', 'markdown.css');
  return {
    name: 'haish:desktop-markdown-seam',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || (!source.startsWith('.') && !path.isAbsolute(source))) return null;
      const resolved = source.startsWith('.') ? path.resolve(path.dirname(importer), source) : source;
      if (resolved.endsWith(path.sep + desktopMarkdownComponent)) return mobileMarkdownComponent;
      // The mobile wrapper imports the desktop stylesheet directly; keep that route on the same
      // generated CSS seam too, otherwise CI would again scan the desktop repo's missing modules.
      return resolved.endsWith(path.sep + desktopSuffix) ? desktopMarkdownCss : null;
    },
  };
}

export default defineConfig({
  plugins: [desktopMarkdownSeam(), react(), tailwindcss()],
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

