import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mobileTraceControls } from '../scripts/mobile-trace-controls.mjs';
const pin = '97aaa54a359eabd4f2a225868df5e19aac8baf9e';
const source = (name) => execFileSync('git', ['-C', '../haish-agent', 'show', `${pin}:app-web/src/features/chat/components/${name}.jsx`], { encoding: 'utf8' });
test('pinned disclosure uses desktop Timer instead of gold chevron', () => {
 const code = mobileTraceControls().transform(source('ChatTimelineNodes'), '/features/chat/components/ChatTimelineNodes.jsx');
 assert.match(code, /MobileTraceTimer className="chat-timeline-time-icon" size=\{13\} strokeWidth=\{2.2\}/);
 assert.doesNotMatch(code, /<ChatTimelineChevron open=\{expanded\}/);
});
test('streaming and settled rows both retain interactive disclosure', () => {
 const code = mobileTraceControls().transform(source('ChatMessageRow'), '/features/chat/components/ChatMessageRow.jsx');
 assert.match(code, /const traceForcedOpen = Boolean\(forceTraceOpen\)/);
 assert.match(code, /const traceExpanded = traceExpansionOverride \?\? \(message.streaming/);
 assert.match(code, /onExpand=\{\(\) => setTraceExpanded\(!traceExpanded\)\}/);
});
test('redundant loading copy removed without removing automatic hydration', () => {
 const code = readFileSync('src/chat-view.jsx', 'utf8');
 assert.doesNotMatch(code, /加载执行过程|trace-load-button/);
 assert.match(code, /if \(taskId\) loadTaskTrace\(taskId\)/);
});
