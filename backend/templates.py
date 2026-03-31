"""Chat template presets for Modelfile generation (pull-and-create)."""

from __future__ import annotations

_IM_END = "</think>"

TEMPLATES = {
    "chatml": """{{- if .System }}<|im_start|>system
{{ .System }}"""
    + _IM_END
    + """
{{ end }}{{- range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}"""
    + _IM_END
    + """
{{ end }}<|im_start|>assistant
""",
    "llama3": """{{ if .System }}system
{{ .System }}<|eot_id|>{{ end }}{{ if .Prompt }}user
{{ .Prompt }}<|eot_id|>{{ end }}assistant
""",
    "mistral": """{{ if .System }}[INST] {{ .System }}
{{ end }}{{ if .Prompt }}[INST] {{ .Prompt }} [/INST]{{ end }}
""",
}

DEFAULT_STOP_TOKENS = {
    "chatml": ["<|im_start|>", _IM_END, "<|endoftext|>"],
    "llama3": ["<|eot_id|>", "", ""],
    "mistral": ["[INST]", "[/INST]"],
}
