// Preserve buttons and keyboard focus while polling updates row status/counts.
export function renderLaunchList(document, list, entries, { open, stop }) {
  const previous = list.launchRows || new Map();
  const next = new Map();
  for (const entry of entries) {
    let row = previous.get(entry.id);
    if (!row) {
      const item = document.createElement('li');
      const text = document.createElement('span');
      const openButton = document.createElement('button');
      const stopButton = document.createElement('button');
      openButton.type = stopButton.type = 'button';
      item.append(text, openButton, stopButton);
      row = { item, text, openButton, stopButton };
      openButton.addEventListener('click', () => { void open(entry.id); });
      stopButton.addEventListener('click', async () => {
        if (stopButton.disabled) return;
        stopButton.disabled = true;
        try { await stop(entry.id); }
        finally { stopButton.disabled = false; }
      });
    }
    row.text.textContent = `${entry.description} `;
    row.openButton.textContent = `Відкрити та редагувати: ${entry.name}`;
    row.stopButton.textContent = `Зупинити: ${entry.name}`;
    if (row.item.parentNode !== list) list.append(row.item);
    next.set(entry.id, row);
  }
  for (const [id, row] of previous) if (!next.has(id)) row.item.remove();
  list.launchRows = next;
}
