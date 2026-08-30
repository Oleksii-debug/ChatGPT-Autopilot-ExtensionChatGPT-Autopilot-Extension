export function normalizeChatUrlForUi(value) {
  const parsed = new URL(String(value || '').trim());
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Потрібне коректне посилання https://chatgpt.com.');
  }
  parsed.hostname = 'chatgpt.com';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
}

function trimUrlPunctuation(value) {
  return value.replace(/[),.;\]}]+$/g, '');
}

export function extractChatUrls(text) {
  const matches = String(text || '').match(/https:\/\/(?:www\.)?chatgpt\.com\/[^\s<>"']+/gi) || [];
  const result = [];
  const seen = new Set();
  for (const raw of matches) {
    try {
      const normalized = normalizeChatUrlForUi(trimUrlPunctuation(raw));
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    } catch {
      // Invalid candidates are ignored; normal Save validation remains authoritative.
    }
  }
  return result;
}
