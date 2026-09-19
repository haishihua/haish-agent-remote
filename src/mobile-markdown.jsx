import React from 'react';
import { cjk } from '@streamdown/cjk';
import { defaultRehypePlugins, Streamdown } from 'streamdown';
import { remarkHardBreaks } from '../../haish-agent/app-web/src/shared/lib/remark-hard-breaks.js';
import '../../haish-agent/app-web/styles/markdown.css';

let codePluginPromise;
let mermaidPluginPromise;

const [sanitizePlugin, sanitizeSchema] = defaultRehypePlugins.sanitize;
const MARKDOWN_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  [sanitizePlugin, {
    ...sanitizeSchema,
    protocols: {
      ...sanitizeSchema.protocols,
      href: [...sanitizeSchema.protocols.href, 'file'],
    },
  }],
];
const LINK_SAFETY = { enabled: false };

function safeMarkdownUrl(url, key) {
  const value = String(url || '').trim();
  if (/^https?:/i.test(value)) return value;
  if (key === 'href' && /^(?:mailto:|file:|#)/i.test(value)) return value;
  return null;
}

/** Desktop Markdown semantics with one mobile-only correction: code line counters are disabled. */
export function Markdown({ source, streaming = false, hardBreaks = false }) {
  const text = String(source || '');
  const [code, setCode] = React.useState(null);
  const [mermaid, setMermaid] = React.useState(null);
  const hasCode = /(`{3,}|~{3,})/.test(text);
  const hasMermaid = /(?:`{3,}|~{3,})mermaid\b/i.test(text);
  const remarkPlugins = React.useMemo(
    () => (hardBreaks ? [remarkHardBreaks] : undefined),
    [hardBreaks],
  );

  React.useEffect(() => {
    if (!hasCode || code) return undefined;
    let active = true;
    codePluginPromise ||= import('@streamdown/code').then((module) => module.code);
    codePluginPromise.then((plugin) => {
      if (active) setCode(plugin);
    }).catch((error) => {
      codePluginPromise = undefined;
      console.error('Markdown code highlighting could not load:', error);
    });
    return () => { active = false; };
  }, [hasCode, code]);

  React.useEffect(() => {
    if (!hasMermaid || mermaid) return undefined;
    let active = true;
    mermaidPluginPromise ||= import('@streamdown/mermaid').then((module) =>
      module.createMermaidPlugin({
        config: {
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: getComputedStyle(document.documentElement)
            .getPropertyValue('--conversation-font').trim() || 'sans-serif',
        },
      }));
    mermaidPluginPromise.then((plugin) => {
      if (active) setMermaid(plugin);
    }).catch((error) => {
      mermaidPluginPromise = undefined;
      console.error('Markdown diagrams could not load:', error);
    });
    return () => { active = false; };
  }, [hasMermaid, mermaid]);

  const plugins = React.useMemo(() => ({ cjk, code, mermaid }), [code, mermaid]);

  return (
    <div className="haish-markdown dark">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        parseIncompleteMarkdown={streaming}
        remarkPlugins={remarkPlugins}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        plugins={plugins}
        codeBlockMaxHeight={320}
        controls
        lineNumbers={false}
        linkSafety={LINK_SAFETY}
        urlTransform={safeMarkdownUrl}
      >
        {text}
      </Streamdown>
    </div>
  );
}
