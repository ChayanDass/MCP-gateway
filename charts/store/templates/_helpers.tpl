{{/* Common labels for every object in the chart. */}}
{{- define "store.labels" -}}
app.kubernetes.io/part-of: woocommerce-store
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Labels that select one component's pods, e.g. component "wordpress". */}}
{{- define "store.selector" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}
