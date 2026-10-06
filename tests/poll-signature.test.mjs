import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationSignature, statusSignature } from '../src/poll-signature.js';

function conversation(overrides = {}) {
  const base = {
    conversation_id: 'conversation-1',
    title: 'Backend cleanup',
    execution_mode: 'chat',
    profile_display_name: 'Haish',
    last_task_id: 'task-1',
    agent_id: 'agent-1',
    messages: [
      { message_id: 'm1', role: 'user', content: 'First', task_id: 'task-1' },
      { message_id: 'm2', role: 'assistant', content: 'Answer', task_id: 'task-1' },
    ],
    tasks: [
      {
        task_id: 'task-1',
        status: 'done',
        created_at: '2026-09-18T10:00:00Z',
        completed_at: '2026-09-18T10:01:00Z',
        assistant_message_id: 'm2',
        answer_text: 'Answer',
        provider_key: 'openai',
        model: 'gpt-5',
        reasoning_effort: 'high',
        request_options: { provider: 'chat:openai', model_id: 'gpt-5', agent_id: 'agent-1', reasoning_effort: 'high' },
        image_attachments: [],
      },
    ],
  };
  return { ...base, ...overrides };
}

test('a poll that brings back the same conversation keeps the same signature', () => {
  // 两次轮询是两个不同的对象（`JSON.parse` 每次都新建），签名必须一样——一样才不重渲染。
  assert.equal(conversationSignature(conversation()), conversationSignature(conversation()));
});

test('every field the detail screen paints moves the signature', () => {
  const base = conversationSignature(conversation());
  const moved = [
    conversation({ title: 'Renamed' }),
    conversation({ last_task_id: 'task-2' }),
    conversation({ messages: [...conversation().messages, { message_id: 'm3', role: 'user', content: 'Again', task_id: 'task-2' }] }),
    conversation({ tasks: [{ ...conversation().tasks[0], status: 'running' }] }),
    conversation({ tasks: [{ ...conversation().tasks[0], completed_at: '' }] }),
    conversation({ tasks: [{ ...conversation().tasks[0], assistant_message_id: null }] }),
    conversation({ tasks: [{ ...conversation().tasks[0], error: 'Context window exceeded' }] }),
    conversation({ tasks: [{ ...conversation().tasks[0], request_options: { ...conversation().tasks[0].request_options, model_id: 'gpt-5-mini' } }] }),
    conversation({ tasks: [{ ...conversation().tasks[0], image_attachments: [{ image_id: 'i1', path: '/tmp/a.png' }] }] }),
  ];
  for (const next of moved) assert.notEqual(conversationSignature(next), base);
});

test('a reply that is still growing moves the signature', () => {
  const first = conversation();
  const growing = conversation({
    messages: [
      { message_id: 'm1', role: 'user', content: 'First', task_id: 'task-1' },
      { message_id: 'm2', role: 'assistant', content: 'Answer, still writ', task_id: 'task-1' },
    ],
  });
  assert.notEqual(conversationSignature(growing), conversationSignature(first));
});

test('a task answer that grew moves the signature even when the id did not', () => {
  const longer = conversation({ tasks: [{ ...conversation().tasks[0], answer_text: 'Answer\n\nAnd more' }] });
  assert.notEqual(conversationSignature(longer), conversationSignature(conversation()));
});

test('missing pieces never throw and never collapse two different conversations', () => {
  assert.equal(conversationSignature(undefined), conversationSignature({}));
  const empty = conversationSignature({ conversation_id: 'a' });
  const other = conversationSignature({ conversation_id: 'b' });
  assert.notEqual(empty, other);
  assert.equal(conversationSignature({ conversation_id: 'a', messages: [], tasks: [] }), empty);
});

test('Bark enablement changes the status signature without delivery-counter churn', () => {
  const local = statusSignature({ paired: true, notifications: { enabled: false } });
  const bark = statusSignature({ paired: true, notifications: { enabled: true } });
  assert.notEqual(local, bark);
  assert.equal(bark, statusSignature({ paired: true, notifications: { enabled: true, delivery_counts: { sent: 10 } } }));
});

test('the status signature ignores the field the server bumps on every request', () => {
  const device = { device_id: 'd1', name: 'iPhone', last_seen_at: 1_789_000_000 };
  const first = statusSignature({ paired: true, runtime_online: true, computer_model: 'MacBook Air', device });
  const later = statusSignature({
    paired: true,
    runtime_online: true,
    computer_model: 'MacBook Air',
    device: { ...device, last_seen_at: 1_789_000_123 },
  });
  assert.equal(later, first);
  // 其余画得出来的字段动了就得变。
  assert.notEqual(statusSignature({ paired: true, runtime_online: false, computer_model: 'MacBook Air', device }), first);
  assert.notEqual(statusSignature({ paired: true, runtime_online: true, computer_model: 'Mac mini', device }), first);
  assert.notEqual(statusSignature({ paired: true, runtime_online: true, computer_model: 'MacBook Air', device: { ...device, name: 'iPad' } }), first);
  assert.notEqual(statusSignature({ paired: false, runtime_online: true, computer_model: 'MacBook Air', device: null }), first);
});
