const assert = require('node:assert/strict');
const transcript = require('./static/transcript.js');
const marked = require('./static/marked.umd.js');
function row(type, payload) { return { value: { type, payload } }; }
function response(role, text, id, kinds) {
  return row('response_item', { type: 'message', role, id, content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-one', content_item_kinds: kinds } });
}
function item(role, text, id) {
  return row('event_msg', { type: 'item_completed', turn_id: 'turn-one',
    item: { type: role === 'user' ? 'UserMessage' : 'AgentMessage', id,
      content: [{ type: role === 'user' ? 'text' : 'Text', text }], phase: role === 'assistant' ? 'final_answer' : undefined } });
}
const rows = [
  response('user', '<environment_context>private</environment_context>', 'context', ['environments.environment_context']),
  response('user', 'hello', 'response-user', ['user.text']),
  item('user', 'hello', 'native-user'),
  row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'tool', command: 'private shell output' } }),
  row('response_item', { type: 'reasoning', summary: [{ text: 'private reasoning' }] }),
  item('assistant', '**answer**', 'answer-one'),
  response('assistant', '**answer**', 'answer-one'),
];
let result = transcript.readMessages(rows);
assert.equal(result.length, 2);
assert.equal(result[0].rowIndex, 2);
assert.deepEqual(result[0].sourceRows, [1, 2]);
assert.equal(result[1].rowIndex, 5);
assert.equal(result[1].text, '**answer**');
assert.equal(transcript.readMessages([...rows, item('user', 'hello', 'another-user')]).length, 3);
assert.equal(transcript.readMessages([response('user', 'injected', 'extra', ['additional_content'])]).length, 0);
assert.equal(transcript.readMessages([response('user', 'malformed metadata', 'extra', [42])]).length, 0);
const analysis = response('assistant', 'hidden analysis', 'analysis'); analysis.value.payload.channel = 'analysis';
assert.equal(transcript.readMessages([analysis]).length, 0);
assert.equal(transcript.displayText('## Referenced chats with Codex:\nmetadata\n## My request:\nactual request'), 'actual request');
assert.equal(transcript.displayText('normal ## My request: words'), 'normal ## My request: words');
result = transcript.readMessages([row('event_msg', { type: 'user_message', message: 'legacy prompt' }),
  row('event_msg', { type: 'agent_message', message: 'legacy reply' })]);
assert.deepEqual(result.map((message) => message.text), ['legacy prompt', 'legacy reply']);
const html = transcript.markdown('**bold** `code`\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)\n\n![pic](https://tracker.invalid/pixel.png)\n\n[link](https://example.com)', marked);
assert.match(html, /<strong>bold<\/strong>/);
assert.match(html, /<code>code<\/code>/);
assert.doesNotMatch(html, /<script>|<img|href="javascript/);
assert.match(html, /&lt;script&gt;/);
assert.match(html, /rel="noopener noreferrer"/);
const withSummary = [...rows, row('event_msg', { type: 'task_complete', turn_id: 'turn-one', last_agent_message: '**answer**' }),
  item('assistant', '**answer**', 'unrelated-answer')];
const assistant = transcript.readMessages(withSummary).find((message) => message.recordId === 'answer-one');
const edit = transcript.editMessage(withSummary, assistant, 'new answer', true);
assert.deepEqual([...edit.updates.keys()], [5, 6, 7]);
assert.equal(edit.relatedCount, 3);
assert.equal(edit.updates.get(7).payload.last_agent_message, 'new answer');
assert.equal(edit.updates.has(8), false);
assert.equal(transcript.editMessage(withSummary, assistant, 'new answer', false).updates.size, 1);
assert.throws(() => transcript.editMessage(withSummary, assistant, ''), /不能为空/);
const attached = item('user', '## Referenced chats with Codex:\ncontext\n## My request:\nhello', 'attached');
attached.value.payload.item.content.push({ type: 'input_image', image_url: 'keep-image' });
const attachmentRows = [attached], attachmentMessage = transcript.readMessages(attachmentRows)[0];
assert.equal(transcript.editableText(attachmentRows, attachmentMessage), 'hello');
const attachmentEdit = transcript.editMessage(attachmentRows, attachmentMessage, 'new prompt');
assert.match(attachmentEdit.updates.get(0).payload.item.content[0].text, /context\n## My request:\nnew prompt/);
assert.equal(attachmentEdit.updates.get(0).payload.item.content[1].image_url, 'keep-image');
console.log('PASS: canonical message extraction, raw-row mapping, duplicate suppression, context/tool/reasoning filtering, legacy messages, safe Markdown.');
