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
  function textReference(record) {
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') return null;
    let target, role, property;
    if (record.type === 'event_msg' && ['AgentMessage', 'UserMessage'].includes(payload.item?.type)) {
      target = payload.item; role = target.type === 'AgentMessage' ? 'assistant' : 'user';
    } else if (record.type === 'response_item' && payload.type === 'message' && ['assistant', 'user'].includes(payload.role)) {
      target = payload; role = target.role;
    } else if (record.type === 'event_msg' && ['agent_message', 'user_message'].includes(payload.type)) {
      target = payload; role = payload.type === 'agent_message' ? 'assistant' : 'user'; property = 'message';
    } else return null;
    if (!property) property = typeof target.text === 'string' && !target.content ? 'text' : 'content';
    const value = target[property];
    const text = typeof value === 'string' ? value : Array.isArray(value) ? value.map((part) =>
      typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n') : '';
    return { target, role, id: target.id || null, property, text,
      turn: payload.turn_id || payload.internal_chat_message_metadata_passthrough?.turn_id || '',
      phase: target.phase || payload.phase || payload.channel || '' };
  }
  function editableText(rows, message) {
    const reference = textReference(rows[message.rowIndex]?.value);
    if (!reference) throw new Error('此消息没有可编辑的文本记录。');
    return displayText(reference.text) !== reference.text.trim() ? displayText(reference.text) : reference.text;
  }
  function replaceReferenceText(reference, text) {
    const raw = reference.text;
    if (displayText(raw) !== raw.trim()) {
      const start = raw.indexOf('## My request:') + '## My request:'.length;
      const tail = raw.slice(start), leading = tail.match(/^\s*/)[0], trailing = tail.match(/\s*$/)[0];
      text = raw.slice(0, start) + leading + text + trailing;
    }
    const value = reference.target[reference.property];
    if (typeof value === 'string') reference.target[reference.property] = text;
    else if (Array.isArray(value)) {
      let replaced = false;
      reference.target[reference.property] = value.map((part) => {
        if (typeof part === 'string') { const next = replaced ? '' : text; replaced = true; return next; }
        if (typeof part?.text === 'string') { const next = { ...part, text: replaced ? '' : text }; replaced = true; return next; }
        return part;
      });
      if (!replaced) throw new Error('此消息仅有附件，请在原始数据中处理。');
    } else throw new Error('不支持的消息内容结构。');
  }
  function editMessage(rows, message, text, mirror = true) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('消息文本不能为空；删除记录请使用原始数据视图。');
    const canonical = textReference(rows[message.rowIndex]?.value);
    if (!canonical) throw new Error('原始消息已发生变化。');
    const aliases = new Set(mirror ? message.sourceRows : [message.rowIndex]);
    const ids = new Set();
    for (const index of aliases) {
      const ref = textReference(rows[index]?.value);
      if (!ref || ref.role !== message.role) continue;
      if (ref.id && ref.id !== canonical.id && ref.text.trim() !== canonical.text.trim()) throw new Error('关联副本文本不一致，请先在原始数据中确认。');
      if (ref.id) ids.add(ref.id);
    }
    const updates = new Map(), candidates = new Set();
    let turn = '', lastAssistant = new Map();
    for (let index = 0; index < rows.length; index++) {
      const record = rows[index].value;
      if (!record?.payload) continue;
      const payload = record.payload;
      if (record.type === 'event_msg' && payload.type === 'task_started') turn = payload.turn_id || '';
      const ref = textReference(record), currentTurn = ref?.turn || payload.turn_id || turn;
      if (ref && ref.phase !== 'analysis') {
        const sameTurn = !message.turn || currentTurn === message.turn;
        const matches = ref.role === message.role && sameTurn &&
          (aliases.has(index) || (mirror && ref.id && ids.has(ref.id)));
        if (matches) {
          const copy = JSON.parse(JSON.stringify(record));
          replaceReferenceText(textReference(copy), text);
          candidates.add(index);
          if (JSON.stringify(copy) !== JSON.stringify(record)) updates.set(index, copy);
        }
        if (ref.role === 'assistant' && ref.text.trim() && payload.type !== 'item_started') {
          lastAssistant.set(currentTurn, { ref, matches, index });
        }
      }
      if (mirror && message.role === 'assistant' && record.type === 'event_msg' &&
          payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
        const last = lastAssistant.get(currentTurn);
        if (last?.matches && payload.last_agent_message.trim() === last.ref.text.trim()) {
          const copy = JSON.parse(JSON.stringify(record)); copy.payload.last_agent_message = text;
          candidates.add(index);
          if (payload.last_agent_message !== text) updates.set(index, copy);
        }
      }
    }
    if (!candidates.has(message.rowIndex)) throw new Error('无法确认消息的原始位置。');
    return { updates, relatedCount: candidates.size };
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
  return { readMessages, displayText, markdown, editableText, editMessage };
});
