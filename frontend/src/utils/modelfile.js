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
    /** Verbatim lines not mapped to guided fields; appended when building raw from guided. */
    preservedUnknownRaw: '',
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

  const core = lines.filter(Boolean).join('\n')
  const pres = (s.preservedUnknownRaw || '').replace(/\r\n/g, '\n').trimEnd()
  const parts = []
  if (core) parts.push(core)
  if (pres) parts.push(pres)
  if (parts.length === 0) return '\n'
  return parts.join('\n') + '\n'
}

/**
 * Consume TEMPLATE/SYSTEM/LICENSE """ ... """ from lines[startIndex].
 * Same-line: INSTRUCTION """ body (optional) or closing """ on same line.
 * Split-line: INSTRUCTION alone, then a line that is exactly """, then body until closing """.
 * Closing delimiter is a full line """ or inline """ after the opening """ on the opener line.
 */
function tryConsumeTripleQuotedInstruction(lines, startIndex) {
  const t = lines[startIndex].trim()

  const splitOpen = t.match(/^(TEMPLATE|SYSTEM|LICENSE)$/i)
  if (splitOpen) {
    let j = startIndex + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (j < lines.length && lines[j].trim() === '"""') {
      const kind = splitOpen[1].toUpperCase()
      const parts = []
      let i = j + 1
      while (i < lines.length) {
        if (lines[i].trim() === '"""') return { kind, body: parts.join('\n'), nextIndex: i + 1 }
        parts.push(lines[i])
        i++
      }
      return { kind, body: parts.join('\n'), nextIndex: lines.length }
    }
  }

  const m = t.match(/^(TEMPLATE|SYSTEM|LICENSE)\s*"""(.*)$/i)
  if (!m) return null
  const kind = m[1].toUpperCase()
  let tail = m[2]
  const inlineClose = tail.indexOf('"""')
  if (inlineClose !== -1) {
    return { kind, body: tail.slice(0, inlineClose), nextIndex: startIndex + 1 }
  }
  const parts = tail.length ? [tail] : []
  let i = startIndex + 1
  while (i < lines.length) {
    if (lines[i].trim() === '"""') return { kind, body: parts.join('\n'), nextIndex: i + 1 }
    parts.push(lines[i])
    i++
  }
  return { kind, body: parts.join('\n'), nextIndex: lines.length }
}

function lineEndsWithUnescapedDoubleQuote(line) {
  if (!line.endsWith('"')) return false
  let bs = 0
  for (let k = line.length - 2; k >= 0 && line[k] === '\\'; k--) bs++
  return bs % 2 === 0
}

/**
 * TEMPLATE/SYSTEM/LICENSE " ... " — closing " must be last char of a line (after trim for opener only; continuation lines use raw content).
 * Same line: TEMPLATE "body" or TEMPLATE "multi\nline body"
 * \" before end-of-line " does not close; even run of \ before final " closes.
 */
function tryConsumeDoubleQuotedInstruction(lines, startIndex) {
  const t = lines[startIndex].trim()
  if (/^(TEMPLATE|SYSTEM|LICENSE)\s*"""/i.test(t)) return null

  const m = t.match(/^(TEMPLATE|SYSTEM|LICENSE)\s*"(.*)$/i)
  if (!m) return null
  const kind = m[1].toUpperCase()
  let rest = m[2]

  if (lineEndsWithUnescapedDoubleQuote(rest)) {
    return { kind, body: rest.slice(0, -1), nextIndex: startIndex + 1 }
  }

  const parts = [rest]
  let i = startIndex + 1
  while (i < lines.length) {
    const line = lines[i]
    if (lineEndsWithUnescapedDoubleQuote(line)) {
      const last = line.slice(0, -1)
      const body = last ? [...parts, last].join('\n') : parts.join('\n')
      return { kind, body, nextIndex: i + 1 }
    }
    parts.push(line)
    i++
  }
  return { kind, body: parts.join('\n'), nextIndex: lines.length }
}

/** First token is an ALL_CAPS modelfile-style verb but not in the known set (for informational count only). */
function isUnknownInstructionKeywordLine(t) {
  const tr = t.trim()
  const m = tr.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
  if (!m) return false
  const tok = m[1]
  const word = tok.toUpperCase()
  if (KNOWN_INSTRUCTIONS.has(word)) return false
  if (/^PARAMETER\s+/i.test(tr)) return false
  return tok === word && /^[A-Z][A-Z0-9_]*$/.test(tok)
}

/**
 * Best-effort parse of a modelfile string into guided state.
 * Only top-level instructions are parsed; TEMPLATE/SYSTEM/LICENSE bodies ("""...""" or "…" to EOL-unescaped ") are one value (inner lines are not instructions).
 * Unmapped lines go to state.preservedUnknownRaw (kept when building raw from guided).
 * @returns {{ state: object, unknownInstructionCount: number }}
 */
export function parseModelfileToGuided(text) {
  const state = defaultGuidedState()
  const preservedLines = []
  let unknownInstructionCount = 0
  const lines = text.split(/\r?\n/)

  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (!t || t.startsWith('#')) {
      i++
      continue
    }

    const block = tryConsumeTripleQuotedInstruction(lines, i)
    if (block) {
      if (block.kind === 'SYSTEM') state.system = block.body
      else if (block.kind === 'TEMPLATE') {
        state.templatePreset = 'raw'
        state.templateRaw = block.body
      } else state.license = block.body
      i = block.nextIndex
      continue
    }

    const dq = tryConsumeDoubleQuotedInstruction(lines, i)
    if (dq) {
      if (dq.kind === 'SYSTEM') state.system = dq.body
      else if (dq.kind === 'TEMPLATE') {
        state.templatePreset = 'raw'
        state.templateRaw = dq.body
      } else state.license = dq.body
      i = dq.nextIndex
      continue
    }

    const fromM = t.match(/^FROM\s+(.+)$/i)
    if (fromM) {
      state.fromCustom = fromM[1].trim()
      state.fromMode = 'custom'
      state.fromSelect = ''
      i++
      continue
    }

    const adM = t.match(/^ADAPTER\s+(.+)$/i)
    if (adM) {
      state.adapter = adM[1].trim()
      i++
      continue
    }

    const reqM = t.match(/^REQUIRES\s+(.+)$/i)
    if (reqM) {
      state.requires = reqM[1].trim()
      i++
      continue
    }

    const paramM = t.match(/^PARAMETER\s+(\S+)\s+(.+)$/i)
    if (paramM) {
      const key = paramM[1].toLowerCase()
      let val = paramM[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1)
      if (key === 'stop') state.stops.push(val)
      else if (Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS, key)) {
        const num = Number(val)
        if (!Number.isNaN(num)) {
          if (key === 'num_ctx') state.params.num_ctx = parseInt(String(val), 10)
          else state.params[key] = num
        }
      }
      i++
      continue
    }

    const msgM = t.match(/^MESSAGE\s+(user|assistant)\s+"(.*)"$/i)
    if (msgM) {
      state.messages.push({
        role: msgM[1].toLowerCase(),
        content: msgM[2].replace(/\\"/g, '"'),
      })
      i++
      continue
    }

    // Single-line SYSTEM / TEMPLATE / LICENSE without quote delimiters (rest of line is the value)
    if (/^SYSTEM\s+/i.test(t) && !/^SYSTEM\s*"""/i.test(t) && !/^SYSTEM\s*"/i.test(t)) {
      const r = t.match(/^SYSTEM\s+(.+)$/i)
      if (r) state.system = r[1].trim()
      i++
      continue
    }
    if (/^TEMPLATE\s+/i.test(t) && !/^TEMPLATE\s*"""/i.test(t) && !/^TEMPLATE\s*"/i.test(t)) {
      const r = t.match(/^TEMPLATE\s+(.+)$/i)
      if (r) {
        state.templatePreset = 'raw'
        state.templateRaw = r[1].trim()
      }
      i++
      continue
    }
    if (/^LICENSE\s+/i.test(t) && !/^LICENSE\s*"""/i.test(t) && !/^LICENSE\s*"/i.test(t)) {
      const r = t.match(/^LICENSE\s+(.+)$/i)
      if (r) state.license = r[1].trim()
      i++
      continue
    }

    const head = t.split(/\s+/)[0]?.toUpperCase() || ''
    if (head && KNOWN_INSTRUCTIONS.has(head)) {
      i++
      continue
    }
    if (/^PARAMETER\s/i.test(t)) {
      i++
      continue
    }
    if (isUnknownInstructionKeywordLine(t)) unknownInstructionCount++
    preservedLines.push(lines[i])
    i++
  }

  state.preservedUnknownRaw = preservedLines.join('\n')
  return { state, unknownInstructionCount }
}

/** Raw-tab validation; unknown instructions are accepted and preserved when syncing from raw, so they are not errors here. */
export function validateRawModelfile(_text) {
  return []
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
