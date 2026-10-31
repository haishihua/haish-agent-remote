// 发送在 runtime 接单前失败（连接抖动 / 超时）时的收尾：除了把草稿还给输入框，还要把乐观切
// 过去的「运行中」退回来。
//
// 真机上踩到的那次：点发送的瞬间连接被重置，`api.startTask` 的 POST 根本没拿到响应
// （`accepted` 永远是 false）。原来这条兜底分支只还了文本和图片，`liveRunRef` 还停在提交
// 那一刻塞进去的本地草稿上——于是 `running` 一直为真：placeholder 变 `Add instructions…`、
// 空输入框显示停止键、发送键的 aria-label 变 `Add instruction`，再点发送会按 steering 打到
// 一个不存在的任务号上；线程里还留一个空的助手气泡。自救只剩点停止键或重启 App。
//
// 这段逻辑在 App.jsx 的 submit() 里（React 组件内部，没有单测脚手架），所以跟这个仓库里
// 其他 composer 行为一样用源码断言钉两件事：提交前先记住上一份活行；接单前失败的分支里
// 把它退回去并立刻 flush（不能等下一帧——界面此刻就要松开「运行中」）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('a send the runtime never accepted hands the optimistic run back', async () => {
  const app = await read('../src/App.jsx');
  // 文件里有两个 submit()：配对页那个不碰 liveRun，这里挑带 `const steering = running;` 的
  // 那一个（详情页的发送）。
  const submitStart = [...app.matchAll(/async function submit\(event\) \{/g)]
    .map((match) => match.index)
    .find((at) => app.slice(at, at + 3000).includes('const steering = running;'));
  assert.ok(Number.isInteger(submitStart), 'App.jsx 里应当还有详情页的 submit()');

  // 1) 记住那一份要放在 try 之前：catch 里拿不到 try 内部的 const。
  // Route validation has its own early try; the stream try starts after the
  // saved live run, which must stay outside that stream recovery scope.
  const streamTry = app.indexOf('try {\n      if (steering)', submitStart);
  assert.ok(streamTry > submitStart);
  const beforeTry = app.slice(submitStart, streamTry);
  assert.match(
    beforeTry,
    /const liveRunBeforeSend = liveRunRef\.current;/,
    '提交前要先记住当时的 liveRun（接单前失败时用它退回）',
  );

  // 2) 接单前失败的兜底分支：文本、图片照旧还回去，外加退回活行 + 立刻提交。
  const catchAt = app.indexOf('} catch (nextError) {', submitStart);
  const rejectAt = app.indexOf('if (steering || !accepted) {', catchAt);
  const rejectEnd = app.indexOf('// The run was accepted and then the stream broke', rejectAt);
  assert.ok(catchAt > 0 && rejectAt > 0 && rejectEnd > rejectAt, '兜底分支的两段应当都还在');
  const rejectBranch = app.slice(rejectAt, rejectEnd);
  assert.match(
    rejectBranch,
    /composerImagesRef\.current = submittedComposerImages;/,
    '失败时草稿（文本与图片）照旧还回输入框',
  );
  assert.match(
    rejectBranch,
    /if \(!steering\) \{\s*liveRunRef\.current = liveRunBeforeSend;\s*flushLiveRun\(\);/,
    '非 steering 的接单前失败要把 liveRun 退回发送前那一份并立刻提交给 React',
  );
});
