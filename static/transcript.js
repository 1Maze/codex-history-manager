(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatTranscript = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (['image', 'input_image', 'image_url', 'local_image'].includes(part.type)) return '[图片]';
      if (['file', 'input_file'].includes(part.type)) return '[附件]';
      return '';
    }).filter(Boolean).join('\n');
  }
  function displayText(text) {
    const trimmed = text.trim();
    if (/^(## Referenced chats with Codex:|# Files mentioned by the user:)/.test(trimmed)) {
      const marker = trimmed.indexOf('## My request:');
      if (marker >= 0) return trimmed.slice(marker + '## My request:'.length).trim();
    }
    return trimmed;
  }
  function syntheticUser(text, metadata) {
    const kinds = metadata?.content_item_kinds;
    if (Array.isArray(kinds) && kinds.length && !kinds.some((kind) => typeof kind === 'string' && kind.startsWith('user.'))) return true;
    return /^\s*<(environment_context|external_codex_apps_open_page|turn_aborted|permissions|collaboration_mode|user_instructions)(?:[>\s])/.test(text);
  }
  function readMessages(rows) {
    const messages = [], byId = new Map(), recent = new Map();
    let currentTurn = '';
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const record = rows[rowIndex].value;
      if (!record || typeof record !== 'object' || !record.payload) continue;
      const payload = record.payload;
      if (record.type === 'event_msg' && payload.type === 'task_started') currentTurn = payload.turn_id || '';
      let role, text, id, phase, priority, kind;
      const metadata = payload.internal_chat_message_metadata_passthrough;
      const turn = payload.turn_id || metadata?.turn_id || currentTurn;
      if (record.type === 'event_msg' && payload.type === 'item_completed' &&
          ['UserMessage', 'AgentMessage'].includes(payload.item?.type)) {
        const item = payload.item;
        role = item.type === 'UserMessage' ? 'user' : 'assistant';
        text = contentText(item.content) || item.text || ''; id = item.id; phase = item.phase;
        priority = 3; kind = 'item';
      } else if (record.type === 'response_item' && payload.type === 'message' &&
                 ['user', 'assistant'].includes(payload.role)) {
        role = payload.role; text = contentText(payload.content); id = payload.id; phase = payload.phase;
        if (payload.channel === 'analysis' || phase === 'analysis') continue;
        if (role === 'user' && syntheticUser(text, metadata)) continue;
        priority = 1; kind = 'response';
      } else if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
        role = payload.type === 'user_message' ? 'user' : 'assistant';
        text = payload.message || ''; id = payload.id; phase = payload.phase;
        priority = 2; kind = 'legacy';
      } else continue;
      if (typeof text !== 'string' || !text.trim() || phase === 'analysis') continue;
      const normalized = text.trim();
      const identity = id ? role + ':' + id : null;
      const bucket = role + ':' + turn;
      let existing = identity ? byId.get(identity) : null;
      const previous = recent.get(bucket);
      if (!existing && previous && previous.kind !== kind && rowIndex - previous.lastRow <= 8 &&
          (previous.originalText === normalized || (role === 'user' && rowIndex - previous.lastRow <= 2))) existing = previous;
      if (existing) {
        existing.sourceRows.push(rowIndex); existing.lastRow = rowIndex;
        if (priority >= existing.priority) Object.assign(existing, {
          text: displayText(text), originalText: normalized, rowIndex, priority, kind,
          recordId: id || existing.recordId,
          phase: phase || existing.phase, timestamp: record.timestamp || existing.timestamp,
        });
        if (identity) byId.set(identity, existing);
        recent.set(bucket, existing);
        continue;
      }
      const message = {
        key: identity || role + ':' + turn + ':row:' + rowIndex,
        recordId: id || null,
        role, text: displayText(text), originalText: normalized, phase: phase || '',
        timestamp: record.timestamp || '', turn, rowIndex, sourceRows: [rowIndex],
        lastRow: rowIndex, priority, kind,
      };
      messages.push(message); if (identity) byId.set(identity, message); recent.set(bucket, message);
    }
    return messages;
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function markdown(text, library) {
    const renderer = new library.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.image = ({ text }) => `<span class="attachment-label">[图片：${escapeHtml(text || '')}]</span>`;
    renderer.link = function ({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      try {
        const url = new URL(href);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return label;
        return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      } catch { return label; }
    };
    return library.parse(text, { renderer, gfm: true, breaks: true, async: false });
  }
  return { readMessages, displayText, markdown };
});
