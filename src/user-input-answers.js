// ask_user 的回答：默认选项与补充文字分开存，一题只产出一种规范答案。
// 形状与 core 的 _normalize_user_input_answers 对齐：
//   只选：{ question_id, kind: 'selection', values: [...] }
//   只写：{ question_id, kind: 'freeform', text: '...' }
//   又选又写：selection 再带 note
//
// 这里是刻意保留的本地副本，不是漏改：iOS CI（.github/workflows/build-ios-unsigned.yml）
// 把桌面仓库 checkout 到固定 ref，桌面端的新文件在 bump ref 之前不存在，直接 import
// 会让唯一 IPA 构建入口失败。改这里的形状时，桌面端
// app-web/src/features/chat/model/ask-user-draft.js 必须同步（两边有各自的测试盯着）。

function draftValues(draft) {
  return Array.isArray(draft?.values) ? draft.values : [];
}

function draftText(draft) {
  return typeof draft?.text === 'string' ? draft.text : '';
}

export function readDraft(drafts, questionId) {
  const draft = drafts?.[questionId];
  return { values: [...draftValues(draft)], text: draftText(draft) };
}

export function toggleDraftSelection(draft, label, multiple = false) {
  const values = draftValues(draft);
  const nextValues = multiple
    ? (values.includes(label) ? values.filter((value) => value !== label) : [...values, label])
    : [label];
  return { values: nextValues, text: draftText(draft) };
}

export function writeDraftText(draft, text) {
  return { values: [...draftValues(draft)], text: String(text ?? '') };
}

export function buildAnswer(question, draft) {
  const values = draftValues(draft);
  const text = draftText(draft).trim();
  if (values.length) {
    return text
      ? { question_id: question.id, kind: 'selection', values: [...values], note: text }
      : { question_id: question.id, kind: 'selection', values: [...values] };
  }
  return text ? { question_id: question.id, kind: 'freeform', text } : null;
}

export function buildAnswers(questions, drafts) {
  return (Array.isArray(questions) ? questions : []).flatMap((question) => {
    const answer = buildAnswer(question, readDraft(drafts, question.id));
    return answer ? [answer] : [];
  });
}

export function allQuestionsAnswered(questions, drafts) {
  const list = Array.isArray(questions) ? questions : [];
  return list.length > 0
    && list.every((question) => buildAnswer(question, readDraft(drafts, question.id)) !== null);
}
