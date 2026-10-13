// The panel's behaviour. The extension host owns every decision; this file only draws and forwards.
(function () {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);

  const transcript = byId('transcript');
  const where = byId('where');
  const model = byId('model');
  const input = byId('text');
  const form = byId('form');
  const send = byId('send');
  const draft = byId('draft');
  const area = byId('area');
  const apply = byId('apply');
  const models = byId('models');

  let busy = false;
  let streaming = null;

  function atBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  }

  function scroll(force) {
    if (force || atBottom()) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }

  function turn(kind, text) {
    const element = document.createElement('div');
    element.className = 'turn ' + kind;
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text || '';
    element.appendChild(body);
    transcript.appendChild(element);
    scroll(true);
    return body;
  }

  function setBusy(value) {
    busy = value;
    send.textContent = value ? 'Stop' : 'Ask';
    send.className = value ? 'quiet' : 'primary';
    draft.disabled = value;
    area.disabled = value;
    models.disabled = value;
    input.disabled = false;
  }

  function chips(items) {
    const row = document.createElement('div');
    row.className = 'chips';
    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (item.stale ? ' stale' : '');
      chip.textContent = item.id.split('/').pop() + (item.stale ? ' · stale' : '');
      chip.title = (item.stale ? 'stale · ' : '') + item.id + ' — ' + item.title;
      chip.addEventListener('click', () => vscode.postMessage({ type: 'open', id: item.id }));
      row.appendChild(chip);
    }
    transcript.appendChild(row);
    scroll(true);
  }

  function state(next) {
    where.textContent = next.page
      ? next.page.title + (next.page.stale ? ' · stale' : '')
      : 'no page open';
    where.title = next.page ? next.page.id : 'Open a page from the Content view';
    model.textContent = next.model
      ? next.model + ' · offline' + (next.version ? ' · ' + next.version : '')
      : next.runtimeReady
        ? 'no model chosen'
        : 'nothing installed';
    apply.classList.toggle('hidden', !next.canApply);
    if (typeof next.busy === 'boolean') {
      setBusy(next.busy);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) {
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const text = input.value.trim();
    if (text.length === 0) {
      return;
    }
    vscode.postMessage({ type: 'ask', text: text });
    input.value = '';
  });

  draft.addEventListener('click', () => {
    vscode.postMessage({ type: 'draft', text: input.value.trim() });
  });

  area.addEventListener('click', () => {
    vscode.postMessage({ type: 'area', text: input.value.trim() });
  });

  apply.addEventListener('click', () => vscode.postMessage({ type: 'apply' }));
  models.addEventListener('click', () => vscode.postMessage({ type: 'models' }));

  input.addEventListener('keydown', (event) => {
    // Enter sends; Shift+Enter starts a new line, as in every chat box.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'state':
        state(message);
        return;
      case 'user':
        turn('user', message.text || '');
        return;
      case 'start':
        streaming = turn('assistant', '');
        return;
      case 'chunk':
        if (streaming) {
          streaming.textContent += message.text;
          scroll(false);
        }
        return;
      case 'end':
        streaming = null;
        return;
      case 'busy':
        setBusy(message.busy === true);
        return;
      case 'note':
        turn('note', message.text);
        return;
      case 'citations':
        chips(message.items || []);
        return;
      case 'results':
        turn('note', message.text || '');
        chips(message.items || []);
        return;
      case 'error':
        turn('error', message.text);
        return;
      default:
        return;
    }
  });
})();
