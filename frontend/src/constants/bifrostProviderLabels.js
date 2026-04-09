/** Display names for Bifrost model id prefixes (before the first `/`). */
export const BIFROST_PROVIDER_LABELS = {
  'llama-desktop': 'Desktop (5090)',
  'llama-gpu': 'GPU (4080S)',
}

function titleCaseKey(key) {
  if (!key) return ''
  return String(key)
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** Label for a provider key; static map first, else humanized key (title case). */
export function labelForBifrostProvider(key) {
  if (key === '_other') return 'Other'
  return BIFROST_PROVIDER_LABELS[key] || titleCaseKey(key)
}
