/** Modelfile assemble / parse helpers for guided + raw sync. */

export const KNOWN_INSTRUCTIONS = new Set([
  'FROM',
  'PARAMETER',
  'TEMPLATE',
  'SYSTEM',
  'MESSAGE',
  'ADAPTER',
  'LICENSE',
  'REQUIRES',
])

const CHATML_STOPS = ['<|im_start|>', '<|im_end|>', '<|endoftext|>']
const LLAMA3_STOPS = ['<|eot_id|>', '<|start_header_id|>']
const MISTRAL_STOPS = ['[/INST]', '</s>']

export const TEMPLATE_PRESETS = [
  {
    id: 'auto',
    label: 'Auto-detect',
    description: 'Omit TEMPLATE; Ollama infers format from the base model.',
    template: '',
    stops: [],
  },
  {
    id: 'chatml',
    label: 'ChatML',
    description: 'OpenAI-style ChatML turns; works for many instruct models.',
    template: `{{- if .Messages }}
{{- range .Messages }}
{{- if eq .Role "user" }}<|im_start|>user
{{ .Content }}<|im_end|>
{{- else if eq .Role "assistant" }}<|im_start|>assistant
{{ .Content }}<|im_end|>
{{- else if eq .Role "system" }}<|im_start|>system
{{ .Content }}<|im_end|>
{{- end }}
{{- end }}
{{- if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{- end }}<|im_start|>assistant
`,
    stops: CHATML_STOPS,
  },
  {
    id: 'llama3',
    label: 'Llama 3',
    description: 'Meta Llama 3 chat template with special tokens.',
    template: `{{- if .Messages }}
{{- range .Messages }}
{{- if eq .Role "user" }}user

{{ .Content }}<|eot_id|>{{- else if eq .Role "assistant" }}assistant

{{ .Content }}<|eot_id|>{{- else if eq .Role "system" }}system

{{ .Content }}<|eot_id|>{{- end }}
{{- end }}
{{- end }}`,
    stops: LLAMA3_STOPS,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    description: 'Mistral [INST] / [/INST] wrapping.',
    template: `[INST] {{ .SystemPrompt }} {{ .Prompt }} [/INST]`,
    stops: MISTRAL_STOPS,
  },
  {
    id: 'raw',
    label: 'Raw / Custom',
    description: 'Provide your own template text below.',
    template: '',
    stops: [],
  },
]

export function getPreset(id) {
  return TEMPLATE_PRESETS.find((p) => p.id === id) || TEMPLATE_PRESETS[0]
}

export const DEFAULT_PARAMS = {
  temperature: 0.7,
  top_k: 40,
  top_p: 0.9,
  min_p: 0,
  num_ctx: 8192,
  num_predict: -1,
  repeat_penalty: 1,
  repeat_last_n: -1,
  seed: 0,
}

export function defaultGuidedState() {
  return {
    fromSelect: '',
    fromCustom: '',
    fromMode: 'pick', // 'pick' | 'custom'
    system: '',
    templatePreset: 'auto',
    templateRaw: '',
    params: { ...DEFAULT_PARAMS },
    stops: [],
    adapter: '',
    messages: [],
    license: '',
    requires: '',
  }
}

function blockQuote(name, body) {
  const t = (body || '').trim()
  if (!t) return ''
  return `${name} """\n${t}\n"""\n`
}

function escapeStop(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildModelfileFromGuided(s) {
  const lines = []
  const fromLine =
    s.fromMode === 'custom' ? (s.fromCustom || '').trim() : (s.fromSelect || '').trim()
  if (fromLine) lines.push(`FROM ${fromLine}`)

  const sys = (s.system || '').trim()
  if (sys) lines.push(blockQuote('SYSTEM', sys).trimEnd())

  const preset = getPreset(s.templatePreset)
  if (s.templatePreset !== 'auto' && preset.id !== 'raw') {
    const t = (preset.template || '').trim()
    if (t) lines.push(blockQuote('TEMPLATE', t).trimEnd())
  } else if (s.templatePreset === 'raw') {
    const t = (s.templateRaw || '').trim()
    if (t) lines.push(blockQuote('TEMPLATE', t).trimEnd())
  }

  const p = s.params || {}
  const addParam = (k, v) => {
    if (v === undefined || v === null || v === '') return
    lines.push(`PARAMETER ${k} ${v}`)
  }
  addParam('temperature', p.temperature)
  addParam('top_k', p.top_k)
  addParam('top_p', p.top_p)
  addParam('min_p', p.min_p)
  addParam('num_ctx', p.num_ctx)
  addParam('num_predict', p.num_predict)
  addParam('repeat_penalty', p.repeat_penalty)
  addParam('repeat_last_n', p.repeat_last_n)
  if (p.seed != null && Number(p.seed) !== 0) addParam('seed', p.seed)

  for (const st of s.stops || []) {
    const t = String(st).trim()
    if (t) lines.push(`PARAMETER stop ${JSON.stringify(t)}`)
  }

  const ad = (s.adapter || '').trim()
  if (ad) lines.push(`ADAPTER ${ad}`)

  for (const m of s.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const c = (m.content || '').trim()
    if (c) lines.push(`MESSAGE ${role} ${JSON.stringify(c)}`)
  }

  const lic = (s.license || '').trim()
  if (lic) lines.push(blockQuote('LICENSE', lic).trimEnd())

  const req = (s.requires || '').trim()
  if (req) lines.push(`REQUIRES ${req}`)

  return lines.filter(Boolean).join('\n') + '\n'
}

/**
 * Best-effort parse of a modelfile string into guided state. Unknown blocks stay in rawWarning.
 */
export function parseModelfileToGuided(text) {
  const state = defaultGuidedState()
  const warnings = []
  let remainder = text

  const fromM = text.match(/^FROM\s+(.+)$/im)
  if (fromM) {
    state.fromCustom = fromM[1].trim()
    state.fromMode = 'custom'
    state.fromSelect = ''
    remainder = remainder.replace(fromM[0], '')
  }

  const sysM = text.match(/SYSTEM\s+"""\s*([\s\S]*?)"""/im)
  if (sysM) {
    state.system = (sysM[1] || '').trim()
    remainder = remainder.replace(sysM[0], '')
  }

  const tplM = text.match(/TEMPLATE\s+"""\s*([\s\S]*?)"""/im)
  if (tplM) {
    state.templatePreset = 'raw'
    state.templateRaw = (tplM[1] || '').trim()
    remainder = remainder.replace(tplM[0], '')
  }

  const licM = text.match(/LICENSE\s+"""\s*([\s\S]*?)"""/im)
  if (licM) {
    state.license = (licM[1] || '').trim()
    remainder = remainder.replace(licM[0], '')
  }

  const adM = text.match(/^ADAPTER\s+(.+)$/im)
  if (adM) {
    state.adapter = adM[1].trim()
    remainder = remainder.replace(adM[0], '')
  }

  const reqM = text.match(/^REQUIRES\s+(.+)$/im)
  if (reqM) {
    state.requires = reqM[1].trim()
    remainder = remainder.replace(reqM[0], '')
  }

  const paramRe = /^PARAMETER\s+(\S+)\s+(.+)$/gim
  let mm
  const paramText = text
  while ((mm = paramRe.exec(paramText))) {
    const key = mm[1].toLowerCase()
    let val = mm[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    if (key === 'stop') {
      state.stops.push(val)
    } else if (Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, key)) {
      const num = Number(val)
      if (Number.isNaN(num)) {
        /* skip */
      } else if (key === 'num_ctx') {
        state.params.num_ctx = parseInt(String(val), 10)
      } else {
        state.params[key] = num
      }
    }
  }

  const msgRe = /^MESSAGE\s+(user|assistant)\s+"(.*)"$/gim
  let m2
  while ((m2 = msgRe.exec(text))) {
    state.messages.push({
      role: m2[1],
      content: m2[2].replace(/\\"/g, '"'),
    })
  }

  const stripped = remainder
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  for (const l of stripped) {
    const head = l.split(/\s+/)[0]?.toUpperCase() || ''
    if (head && KNOWN_INSTRUCTIONS.has(head)) continue
    if (/^PARAMETER\s/i.test(l)) continue
    if (l.length > 0) warnings.push(`Unparsed line: ${l.slice(0, 80)}`)
  }

  return { state, warnings }
}

export function validateRawModelfile(text) {
  const errors = []
  const lines = text.split('\n')
  lines.forEach((line, idx) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    const word = t.split(/\s+/)[0]?.toUpperCase()
    if (word && !KNOWN_INSTRUCTIONS.has(word) && !/^PARAMETER\s+/i.test(t)) {
      errors.push({ line: idx + 1, message: `Unknown instruction: ${word}` })
    }
  })
  return errors
}

export function formatModelfileText(text) {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function highlightModelfileLine(line) {
  const t = line
  if (/^\s*#/.test(t)) return [{ kind: 'comment', text: t }]
  const m = t.match(/^(\s*)([A-Za-z_]+)(\s*)(.*)$/)
  if (!m) return [{ kind: 'text', text: t }]
  const [, sp, w, sp2, rest] = m
  const up = w.toUpperCase()
  const isKw = KNOWN_INSTRUCTIONS.has(up)
  return [
    { kind: 'text', text: sp },
    { kind: isKw ? 'keyword' : 'text', text: w },
    { kind: 'text', text: sp2 + rest },
  ]
}
