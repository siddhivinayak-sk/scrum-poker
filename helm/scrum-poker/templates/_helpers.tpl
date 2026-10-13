{{/*
Chart name, overridable with nameOverride.
Truncated to 63 characters because some Kubernetes name fields are limited to
that by the DNS label spec, and trailing hyphens are removed so the final
character is always alphanumeric.
*/}}
{{- define "scrum-poker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Release-qualified resource name.
fullnameOverride wins outright; otherwise the release name is used as-is when
it already contains the chart name, to avoid names such as
"scrum-poker-scrum-poker". The result is truncated to 63 characters with every
trailing hyphen removed, so the final character is alphanumeric.
*/}}
{{- define "scrum-poker.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version for the helm.sh/chart label.
"+" is not valid in a label value, so build metadata is replaced with "_".
*/}}
{{- define "scrum-poker.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every rendered resource.

Every value is quoted. A label value is a string in the Kubernetes API, but an
unquoted render of a value such as 3, 007, 1e5, 0x10, or true is read back by
the YAML parser as a number or a boolean, which the API server rejects with
"cannot unmarshal number into Go struct field ObjectMeta.labels of type
string". Quoting is what keeps every applied label value a string.
*/}}
{{- define "scrum-poker.labels" -}}
helm.sh/chart: {{ include "scrum-poker.chart" . | quote }}
{{ include "scrum-poker.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{/*
Selector labels — exactly these two keys and nothing else.
Deployment.spec.selector is immutable after creation, so a version-derived
label here would make every appVersion bump an un-upgradeable release.

Both values are quoted for the reason given on scrum-poker.labels: a release
name or nameOverride of 3 would otherwise render an integer label value.
*/}}
{{- define "scrum-poker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "scrum-poker.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{/*
Name of the ServiceAccount the pod runs as.
When serviceAccount.create is false and serviceAccount.name is empty, this
resolves to the namespace "default" ServiceAccount.
*/}}
{{- define "scrum-poker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "scrum-poker.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
{{/*
Name of the ConfigMap holding the application configuration.
The "-config" suffix is 7 characters, so the fullname base is truncated to 56
to keep the result within the 63-character limit. trimSuffix is applied to the
base before the suffix is appended; the final character is alphanumeric
because the suffix itself ends in a letter.
*/}}
{{- define "scrum-poker.configMapName" -}}
{{- printf "%s-config" (include "scrum-poker.fullname" . | trunc 56 | trimSuffix "-") -}}
{{- end -}}

{{/*
Name of the Secret holding the JWT signing key.
The "-secret" suffix is 7 characters, so the same 56-character base truncation
as scrum-poker.configMapName applies.
*/}}
{{- define "scrum-poker.secretName" -}}
{{- printf "%s-secret" (include "scrum-poker.fullname" . | trunc 56 | trimSuffix "-") -}}
{{- end -}}

{{/*
config.basePath normalised for comparison against ingress paths.
An empty basePath means "cluster root", which the ingress expresses as "/", so
an empty value maps to "/" and any other value is returned unchanged.
*/}}
{{- define "scrum-poker.normalizedBasePath" -}}
{{- if .Values.config.basePath -}}
{{- .Values.config.basePath -}}
{{- else -}}
{{- "/" -}}
{{- end -}}
{{- end -}}

{{/*
Cross-field validation, included as the first action of every template file so
no guard can be bypassed by an optional resource being disabled.

Layer 2 of the two-layer validation scheme: values.schema.json runs first and
catches types, enumerated sets, numeric bounds, and string lengths; the guards
below catch the cross-field semantics the schema cannot express, and repeat a
handful of single-field checks so the chart still holds when the schema is
bypassed, as it is by a vendored copy of the templates or by a Helm release
that skips schema validation.

Guard order is fixed and is the order written here, independent of the lexical
file order Helm walks, so the message for a given set of values is
deterministic. The whole body is chomped on both delimiters, so a passing
render yields the empty string and contributes no YAML.

Every message takes the shape
    <values.path>: <what is wrong> (<what is permitted or what was supplied>)
so the smoke test can grep for the path and an operator can read the fix off
the message.

Guards 1-13 are all implemented here, in this order:
   1 replicaCount present, integer, >= 1   2 autoscaling.enabled is false
   3 image.repository non-empty            4 image.pullPolicy in set
   5 deploymentStrategy.type in set        6 config.basePath leading "/"
   7 config.basePath no trailing "/"       8 every extraEnv entry has a name
   9 jwtSecret / existingSecret exclusive 10 service.nodePort range
  11 enabled ingress has a host           12 every host entry has a path
  13 base path matches ingress paths
*/}}
{{- define "scrum-poker.validate" -}}
{{- $image := default (dict) .Values.image -}}

{{- /*
Guard 1 - replicaCount present, an integer, and at least 1.
Requirements 10.8 and 2.16. The schema sets minimum 1 but declares no maximum
and cannot be relied on when it is skipped, so the kind is checked here too.
Helm loads values through sigs.k8s.io/yaml, so a YAML integer arrives as
float64; int and int64 are accepted as well rather than depending on that.
*/ -}}
{{- $replicaCount := .Values.replicaCount -}}
{{- $replicaCountOk := false -}}
{{- if or (kindIs "int" $replicaCount) (kindIs "int64" $replicaCount) (kindIs "float64" $replicaCount) -}}
{{- $replicas := float64 $replicaCount -}}
{{- if and (ge $replicas 1.0) (eq $replicas (floor $replicas)) -}}
{{- $replicaCountOk = true -}}
{{- end -}}
{{- end -}}
{{- if not $replicaCountOk -}}
{{- fail (printf "replicaCount: must be an integer of at least 1 (got %v)" $replicaCount) -}}
{{- end -}}

{{- /*
Guard 2 - autoscaling stays disabled.
Requirement 10.7. Poker and retro session state lives in the memory of one
Node.js process, so a HorizontalPodAutoscaler would split one session across
pods that share nothing.
*/ -}}
{{- $autoscaling := default (dict) .Values.autoscaling -}}
{{- if $autoscaling.enabled -}}
{{- fail (printf "autoscaling.enabled: must be false (got %v); the application holds poker and retro session state in process memory and supports exactly one replica" $autoscaling.enabled) -}}
{{- end -}}

{{- /*
Guard 3 - image.repository non-empty.
Requirement 2.16. An empty repository renders an image reference of ":tag",
which the kubelet cannot pull.
*/ -}}
{{- $repository := default "" $image.repository -}}
{{- if not $repository -}}
{{- fail (printf "image.repository: must be a non-empty string (got %q)" (printf "%v" $repository)) -}}
{{- end -}}

{{- /*
Guard 4 - image.pullPolicy within the permitted set.
Requirement 2.16. A nil or empty policy would render an empty imagePullPolicy
rather than falling back to a Kubernetes default, so it is rejected here.
*/ -}}
{{- $pullPolicies := list "Always" "IfNotPresent" "Never" -}}
{{- $pullPolicy := default "" $image.pullPolicy -}}
{{- if not (has $pullPolicy $pullPolicies) -}}
{{- fail (printf "image.pullPolicy: %q is not permitted (permitted: %s)" (printf "%v" $pullPolicy) (join ", " $pullPolicies)) -}}
{{- end -}}

{{- /*
Guard 5 - deploymentStrategy.type within the permitted set.
Requirement 2.16. values.schema.json deliberately leaves this key
unconstrained, so this guard is the only thing enforcing the set. An absent
key, or an explicit null, falls through to the Recreate default the Deployment
template applies (Requirement 2.14); any supplied value is checked.
*/ -}}
{{- $strategyTypes := list "Recreate" "RollingUpdate" -}}
{{- $strategy := default (dict) .Values.deploymentStrategy -}}
{{- $strategyType := $strategy.type -}}
{{- if not (kindIs "invalid" $strategyType) -}}
{{- if not (has $strategyType $strategyTypes) -}}
{{- fail (printf "deploymentStrategy.type: %q is not permitted (permitted: %s)" (printf "%v" $strategyType) (join ", " $strategyTypes)) -}}
{{- end -}}
{{- end -}}

{{- /*
Guard 6 - config.basePath carries a leading "/".
Requirement 4.9. values.schema.json already applies the "^$|^/" pattern, so on
a normal render this guard never speaks; it is the second layer that still
holds when the schema is bypassed. An empty value is permitted and means the
cluster root. The value is stringified through %v first, so a non-string that
slipped past the schema reports here instead of erroring inside hasPrefix.

Guards 6 and 7 precede guard 13 deliberately: a value such as "scrum-poker" is
both malformed and mismatched, and the smoke test expects the format message.
*/ -}}
{{- $config := default (dict) .Values.config -}}
{{- $basePath := printf "%v" (default "" $config.basePath) -}}
{{- if and $basePath (not (hasPrefix "/" $basePath)) -}}
{{- fail (printf "config.basePath: %q requires a leading \"/\" (supply %q, or \"\" to serve at the cluster root)" $basePath (printf "/%s" $basePath)) -}}
{{- end -}}

{{- /*
Guard 7 - config.basePath carries no trailing "/".
Requirement 4.10. A bare "/" is the cluster root and is legitimate, as is the
empty string, so only a value longer than one character is checked. The
application joins BASE_PATH with its route paths directly, so a trailing
separator would yield "//api/health".
*/ -}}
{{- if and (gt (len $basePath) 1) (hasSuffix "/" $basePath) -}}
{{- fail (printf "config.basePath: %q must not end with \"/\" (supply %q instead)" $basePath (trimSuffix "/" $basePath)) -}}
{{- end -}}

{{- /*
Guard 8 - every extraEnv entry carries a non-empty name.
Requirement 4.12. An entry with a missing or empty name renders an env list
item the API server rejects, which would otherwise surface as a server-side
apply error rather than a render-time message. An entry that is not a mapping
at all is caught by the same guard, because its name reads as empty.
*/ -}}
{{- range $index, $entry := default (list) .Values.extraEnv -}}
{{- $entryName := "" -}}
{{- if kindIs "map" $entry -}}
{{- $entryName = printf "%v" (default "" (index $entry "name")) -}}
{{- end -}}
{{- if not $entryName -}}
{{- fail (printf "extraEnv[%d].name: every extraEnv entry requires a non-empty name (got %q)" $index $entryName) -}}
{{- end -}}
{{- end -}}

{{- /*
Guard 9 - auth.jwtSecret and auth.existingSecret are mutually exclusive.
Requirement 5.11. Supplying both is ambiguous: auth.jwtSecret asks the chart to
render a Secret, auth.existingSecret asks it to render none and reference one
the operator manages. Rather than silently picking a winner, the chart refuses.
The message names both paths but prints only auth.existingSecret, so the
signing key never reaches an operator's terminal or CI log.
*/ -}}
{{- $auth := default (dict) .Values.auth -}}
{{- $jwtSecret := printf "%v" (default "" $auth.jwtSecret) -}}
{{- $existingSecret := printf "%v" (default "" $auth.existingSecret) -}}
{{- if and $jwtSecret $existingSecret -}}
{{- fail (printf "auth.jwtSecret: must be empty when auth.existingSecret is set, the two are mutually exclusive (auth.existingSecret is %q; clear one of them)" $existingSecret) -}}
{{- end -}}

{{- /*
Guard 10 - service.nodePort inside the NodePort range.
Requirement 3.10. values.schema.json already applies the 30000-32767 bounds, so
this guard is pre-empted on a normal render and stands as the second layer for
a bypassed schema. It speaks only when service.type is NodePort: for any other
type the Service template omits nodePort entirely (Requirement 3.11), so a
leftover value is not an error. A nil value - the chart default - is permitted
and lets the cluster allocate the port. A value that is not an integer at all
reports here rather than erroring inside the comparison.
*/ -}}
{{- $service := default (dict) .Values.service -}}
{{- if eq (printf "%v" (default "" $service.type)) "NodePort" -}}
{{- $nodePort := $service.nodePort -}}
{{- if not (kindIs "invalid" $nodePort) -}}
{{- $nodePortOk := false -}}
{{- if or (kindIs "int" $nodePort) (kindIs "int64" $nodePort) (kindIs "float64" $nodePort) -}}
{{- $port := float64 $nodePort -}}
{{- if and (eq $port (floor $port)) (ge $port 30000.0) (le $port 32767.0) -}}
{{- $nodePortOk = true -}}
{{- end -}}
{{- end -}}
{{- if not $nodePortOk -}}
{{- fail (printf "service.nodePort: %v is outside the permitted range 30000-32767 for service.type NodePort (supply an integer in 30000-32767, or null to let the cluster allocate one)" $nodePort) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- $ingress := default (dict) .Values.ingress -}}
{{- if $ingress.enabled -}}
{{- $hosts := default (list) $ingress.hosts -}}

{{- /*
Guard 11 - an enabled ingress carries at least one host entry.
Requirement 8.14. An empty or absent list renders an Ingress with no rules,
which the API server accepts and which then routes nothing, so the operator
would see a healthy release serving nothing at all.
*/ -}}
{{- if eq (len $hosts) 0 -}}
{{- fail "ingress.hosts: an enabled ingress requires at least one host entry (supply at least one entry, or set ingress.enabled=false)" -}}
{{- end -}}

{{- /*
Guard 12 - every host entry carries at least one path entry.
Requirement 9.7. The message names the zero-based ingress.hosts index, because
with several host entries the operator needs to know which one is short. A host
entry that is not a mapping is caught by the same guard, because its paths list
reads as empty. This guard precedes guard 13, which iterates the very lists
proved non-empty here.
*/ -}}
{{- range $hostIndex, $hostEntry := $hosts -}}
{{- $hostName := "" -}}
{{- $paths := list -}}
{{- if kindIs "map" $hostEntry -}}
{{- $hostName = printf "%v" (default "" (index $hostEntry "host")) -}}
{{- $paths = default (list) (index $hostEntry "paths") -}}
{{- end -}}
{{- if eq (len $paths) 0 -}}
{{- fail (printf "ingress.hosts[%d]: requires at least one path entry (host %q carries none; supply at least one paths entry)" $hostIndex $hostName) -}}
{{- end -}}
{{- end -}}

{{- /*
Guard 13 - config.basePath agrees with every ingress path.
Requirements 9.1, 9.2, 9.3. Active only while ingress.enabled and
config.preservePath are both true: with preservePath false the ingress rewrites
the request path to "/" before it reaches the application, so the two are
deliberately free to differ.

With preservePath true the ingress forwards the full path and server.ts rewrites
the <base href> and every asset URL to BASE_PATH, so a path the ingress does not
forward yields a blank page with 404ing assets - a failure that only shows up in
a browser. The chart refuses to render instead.

Comparison is exact string equality after two normalisations: an empty basePath
means the cluster root and maps to "/" via scrum-poker.normalizedBasePath, and
exactly one trailing "/" is stripped from an ingress path longer than one
character, so "/scrum-poker/" and "/scrum-poker" are the same prefix. Guards 6
and 7 ran first, so basePath itself is already known to be well formed.

The first mismatch aborts, naming config.basePath, the mismatched path, and the
zero-based ingress.hosts index.
*/ -}}
{{- if $config.preservePath -}}
{{- $normalizedBasePath := include "scrum-poker.normalizedBasePath" $ -}}
{{- range $hostIndex, $hostEntry := $hosts -}}
{{- $paths := list -}}
{{- if kindIs "map" $hostEntry -}}
{{- $paths = default (list) (index $hostEntry "paths") -}}
{{- end -}}
{{- range $pathIndex, $pathEntry := $paths -}}
{{- $rawPath := "" -}}
{{- if kindIs "map" $pathEntry -}}
{{- $rawPath = printf "%v" (default "" (index $pathEntry "path")) -}}
{{- end -}}
{{- $comparePath := $rawPath -}}
{{- if gt (len $comparePath) 1 -}}
{{- $comparePath = trimSuffix "/" $comparePath -}}
{{- end -}}
{{- if ne $comparePath $normalizedBasePath -}}
{{- fail (printf "config.basePath: %q does not match ingress.hosts[%d].paths[%d].path %q (with config.preservePath=true the ingress forwards the full path, so the two must be equal; set config.basePath to %q, change the ingress path, or set config.preservePath=false)" $normalizedBasePath $hostIndex $pathIndex $rawPath $comparePath) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- end -}}
{{- end -}}
{{/*
Resolved plain-text JWT signing key.

Precedence:
  1. a non-empty auth.jwtSecret, used verbatim so an explicit value always
     wins over anything already stored in the release namespace;
  2. the JWT_SECRET key of an existing Secret with the rendered name in the
     release namespace, b64dec'd, so an upgrade keeps tokens issued before it
     verifiable;
  3. a freshly generated 32-character value from randAlphaNum, which draws
     from upper-case letters, lower-case letters, and digits.

Note on lookup: Helm's lookup returns an empty map whenever there is no live
API connection, which is the case for `helm template` and for client-side
`helm lint`. Step 2 therefore applies only to a live `helm install` /
`helm upgrade`; offline renders fall through to step 3 and produce a fresh
value on every render. That is why the Secret is excluded from the
checksum/config pod annotation.
*/}}
{{- define "scrum-poker.jwtSecret" -}}
{{- if .Values.auth.jwtSecret -}}
{{- .Values.auth.jwtSecret -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "scrum-poker.secretName" .) -}}
{{- $stored := "" -}}
{{- if and $existing $existing.data -}}
{{- $stored = index $existing.data "JWT_SECRET" | default "" -}}
{{- end -}}
{{- if $stored -}}
{{- $stored | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}
