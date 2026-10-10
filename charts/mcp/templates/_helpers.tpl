{{/* Common labels for every object in the MCP chart. */}}
{{- define "mcp.labels" -}}
app.kubernetes.io/part-of: mcp-gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Labels that select one component's pods, e.g. component "gateway". */}}
{{- define "mcp.selector" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}
