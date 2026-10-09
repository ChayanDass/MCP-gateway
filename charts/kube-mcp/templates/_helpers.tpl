{{- define "kube-mcp.labels" -}}
app.kubernetes.io/part-of: kube-mcp
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kube-mcp.componentLabels" -}}
{{ include "kube-mcp.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "kube-mcp.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Probes and resources are rendered from a per-workload block in values. */}}
{{- define "kube-mcp.resources" -}}
resources:
  requests:
    cpu: {{ .requests.cpu | quote }}
    memory: {{ .requests.memory | quote }}
  limits:
    cpu: {{ .limits.cpu | quote }}
    memory: {{ .limits.memory | quote }}
{{- end -}}

{{- define "kube-mcp.secretName" -}}
{{- .Values.secrets.name -}}
{{- end -}}
