// Mobile-only seam over the pinned desktop components; never edits that checkout.
export function mobileTraceControls() {
  return {
    name: 'haish:mobile-trace-controls',
    enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/features/chat/components/ChatTimelineNodes.jsx')) {
        code = code.replace("from 'lucide-react';", "from 'lucide-react';\nimport { Timer as MobileTraceTimer } from 'lucide-react';");
        code = code.replace('<ChatTimelineChevron open={expanded} />', '<MobileTraceTimer className="chat-timeline-time-icon" size={13} strokeWidth={2.2} aria-hidden="true" />');
        return code;
      }
      if (id.endsWith('/features/chat/components/ChatMessageRow.jsx')) {
        code = code.replace('const traceExpanded = traceExpansionOverride ?? message.status === \'cancelled\';', "const traceExpanded = traceExpansionOverride ?? (message.streaming || message.status === 'cancelled');");
        code = code.replace('const traceForcedOpen = message.streaming || message.traceOpen || forceTraceOpen;', 'const traceForcedOpen = Boolean(forceTraceOpen);');
        return code;
      }
      return null;
    },
  };
}
