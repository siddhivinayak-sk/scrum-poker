# Implementation Plan: Helm Chart Deployment

## Overview

Build the chart at `helm/scrum-poker/` in dependency order so every step is renderable and verifiable with the locally available tooling (`helm v3.15.1`, `kubectl v1.35.0`).

Two ordering facts drive the sequence:

1. **Every template file's first action is `{{- include "scrum-poker.validate" . -}}`.** A no-op `scrum-poker.validate` stub therefore lands in `_helpers.tpl` (task 2.2) *before* the first template is written, and is filled in with the 13 real guards only after every template exists (tasks 13.1–13.3). Without the stub, nothing renders.
2. **`values.schema.json` can only be written once `values.yaml` is final.** Requirement 11.1 demands the schema accept every declared default without error, so the schema (task 12.1) comes after every template has fixed the shape of `values.yaml`. Any value key added by a later template task must be added to `values.yaml` in that same task, and task 12.1 is the point at which the two files are reconciled.

The two primary verification gates, used throughout:

```bash
helm lint helm/scrum-poker
helm template release-name helm/scrum-poker | kubectl apply --dry-run=client -f -
```

Build order: `Chart.yaml` + `values.yaml` → `_helpers.tpl` naming/labelling → ConfigMap → Secret (+ `jwtSecret` lookup) → ServiceAccount → Deployment → Service → Ingress → `NOTES.txt` → `values.schema.json` → the 13 guards → `tests/helm-smoke.test.sh` → `README.md`.

**Out of scope:** `tests/k8s-smoke.test.sh`. It references `k8s/deployment.yaml` and `k8s/service.yaml`, neither of which exists, and shares no code or fixtures with the chart test path. Per the design's recorded decision, it is left unchanged by this plan. No task below touches it.

**No chart build step.** The chart is rendered, not compiled. The only `package.json` introduced is the one the design specifies for the property-test harness at `tests/helm/`; the chart directory itself stays test-free so `helm package` produces a clean artifact.

## Tasks

- [x] 1. Chart scaffolding and default values
  - [x] 1.1 Create `helm/scrum-poker/Chart.yaml` and `helm/scrum-poker/.helmignore`
    - Set `apiVersion: v2`, `name: scrum-poker`, `type: application`, `version: 0.1.0`, `appVersion: "latest"` (quoted), `kubeVersion: ">=1.19.0-0"`
    - Write a `description` between 20 and 200 characters
    - `.helmignore` excludes `.git`, `*.tgz`, and editor files; it is additive and carries no values-table obligation
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.2 Create `helm/scrum-poker/values.yaml` with the complete default set
    - Reproduce every key and default in the design's `values.yaml` listing, including `replicaCount: 1`, `image`, `imagePullSecrets`, `nameOverride`, `fullnameOverride`, `serviceAccount`, `podAnnotations`, `podSecurityContext`, `securityContext`, `tmpVolume`, `service`, `deploymentStrategy`, `ingress`, `config`, `auth`, `extraEnv`, `resources`, `readinessProbe`, `livenessProbe`, `nodeSelector`, `tolerations`, `affinity`, `autoscaling`
    - Defaults must reproduce the `k8s/k8s.yaml` and `k8s/ingress.yaml` topology: ClusterIP 80 → 3000, `BASE_PATH=/scrum-poker`, `PRESERVE_PATH=true`, nginx ingress at `/scrum-poker` with an empty host, `100m`/`128Mi` requests and `500m`/`512Mi` limits
    - Every top-level key carries a comment of at least 10 characters stating its purpose, and names the permitted values for every schema-enumerated key
    - `replicaCount` carries a comment stating that `1` is the only supported value; `auth.jwtSecret` carries a comment stating that an empty value triggers 32-character random generation at install time
    - `service.nodePort` defaults to `null` so the key is documented but absent from rendering
    - _Requirements: 1.2, 3.5, 4.5, 5.9, 6.4, 6.5, 7.2, 7.5, 7.6, 8.3, 8.7, 10.1, 10.5, 10.6, 13.10_

- [x] 2. Named template helpers
  - [x] 2.1 Create `helm/scrum-poker/templates/_helpers.tpl` with naming and labelling templates
    - Define `scrum-poker.name`, `scrum-poker.fullname`, `scrum-poker.chart`, `scrum-poker.labels`, `scrum-poker.selectorLabels`, `scrum-poker.serviceAccountName`
    - `scrum-poker.fullname` applies `trunc 63 | trimSuffix "-"` so the final character is alphanumeric
    - `scrum-poker.labels` emits `helm.sh/chart`, both selector labels, `app.kubernetes.io/version` (quoted `.Chart.AppVersion`), and `app.kubernetes.io/managed-by`
    - `scrum-poker.selectorLabels` emits exactly `app.kubernetes.io/name` and `app.kubernetes.io/instance` and nothing else, so `Deployment.spec.selector` stays immutable across an `appVersion` bump
    - _Requirements: 1.8, 1.9, 1.10, 1.11_

  - [x] 2.2 Add derived-name helpers, base-path normalisation, and the validation stub to `_helpers.tpl`
    - `scrum-poker.configMapName` and `scrum-poker.secretName`: `trunc 56 | trimSuffix "-"` on the fullname base before appending the 7-character `-config` / `-secret` suffix, keeping the result within 63 characters
    - `scrum-poker.normalizedBasePath`: returns `/` when `config.basePath` is empty, otherwise the value unchanged
    - `scrum-poker.validate`: define it now as a no-op that yields the empty string with both delimiters chomped, so template files can include it from the start; the 13 guards are added in tasks 13.1–13.3
    - _Requirements: 1.8, 1.9, 4.1, 5.1_

  - [x] 2.3 Set up the property-test harness at `tests/helm/`
    - Create `tests/helm/package.json` with pinned `vitest` and `fast-check` devDependencies and a `test:helm` script
    - Implement the shared `renderChart(values, opts)` helper returning `{ status, stdout, stderr, docs }`: write generated values to a temp file, spawn `helm template <release> helm/scrum-poker -f <tmp> --namespace <ns>`, parse the YAML stream on success, delete the temp file
    - Use a values *file* rather than `--set`, so generated annotation keys containing dots or commas are testable
    - Create the shared generator module with `releaseNameArb`, `validValuesArb`, `annotationMapArb`, `hostsArb`, `basePathArb`, `secretValueArb`, `guardViolationArb`, `schemaViolationArb`
    - Configure `fc.assert` with `numRuns: 100` minimum; each property test derives all its assertions from a single render per iteration
    - _Requirements: 12.2_

  - [x] 2.4 Write property test for rendered resource name bounds
    - **Property 1: Rendered resource names stay inside Kubernetes bounds**
    - **Validates: Requirements 1.9, 1.10, 2.2, 3.2, 4.1, 12.14**

  - [x] 2.5 Write property test for the selector label set
    - **Property 2: The selector label set is fixed and version-independent**
    - **Validates: Requirements 1.11, 2.8, 3.6**

- [x] 3. ConfigMap template
  - [x] 3.1 Create `helm/scrum-poker/templates/configmap.yaml`
    - Include `scrum-poker.validate` as the first action
    - Name from `scrum-poker.configMapName`, labels from `scrum-poker.labels`
    - Emit exactly four `data` keys — `PORT`, `NODE_ENV`, `BASE_PATH`, `PRESERVE_PATH` — each piped through `quote`, so the integer `3000` renders `"3000"`, the boolean renders `"true"`/`"false"`, and an empty `config.basePath` renders a present key with the value `""`
    - Verify with `helm template` that the four keys render as quoted strings
    - _Requirements: 4.1, 4.2, 4.3, 4.6_

  - [x] 3.2 Write unit tests for ConfigMap value quoting
    - Assert exactly four keys, assert every value is a quoted string, assert the `BASE_PATH` key is present with value `""` when `config.basePath` is empty
    - _Requirements: 4.2, 4.3, 4.6_

- [x] 4. Secret template and JWT resolution
  - [x] 4.1 Add `scrum-poker.jwtSecret` to `_helpers.tpl`
    - Precedence: non-empty `auth.jwtSecret` → stored cluster value via `lookup "v1" "Secret" .Release.Namespace (include "scrum-poker.secretName" .)` with `b64dec` → `randAlphaNum 32`
    - Note in a template comment that `lookup` returns an empty map under `helm template` and client-side `helm lint`, so reuse applies only to a live `helm install`/`helm upgrade`
    - _Requirements: 5.6, 5.7, 5.8_

  - [x] 4.2 Create `helm/scrum-poker/templates/secret.yaml`
    - Include `scrum-poker.validate` first, then wrap the entire document body in `{{- if not .Values.auth.existingSecret }}` so a non-empty `auth.existingSecret` renders zero resources rather than an empty document separator
    - `apiVersion: v1`, `kind: Secret`, `type: Opaque`, name from `scrum-poker.secretName`, labels from `scrum-poker.labels`
    - Exactly one data key `JWT_SECRET`, piped `include "scrum-poker.jwtSecret" . | b64enc | quote`, and no additional key
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 4.3 Write property test for JWT secret encoding and generation
    - **Property 8: The JWT secret survives encoding and is generated to specification**
    - **Validates: Requirements 5.2, 5.5, 5.6**

  - [x] 4.4 Write integration tests for secret reuse across upgrade
    - Requires a live cluster; `lookup` returns an empty map offline, so these cannot be offline property tests
    - Install, read `JWT_SECRET`, `helm upgrade` with unchanged values, assert the value is identical
    - Install with generation, upgrade with an explicit non-empty `auth.jwtSecret`, assert the explicit value is stored
    - _Requirements: 5.7, 5.8_

- [x] 5. ServiceAccount template
  - [x] 5.1 Create `helm/scrum-poker/templates/serviceaccount.yaml`
    - Include `scrum-poker.validate` first; gate the document on `serviceAccount.create`
    - Name from `scrum-poker.serviceAccountName`, labels from `scrum-poker.labels`, `serviceAccount.annotations` rendered under `with` so an empty mapping omits the field
    - _Requirements: 2.11_

  - [x] 5.2 Write unit tests for the four ServiceAccount combinations
    - `create=true` with and without `name`; `create=false` with and without `name`, the latter resolving to the namespace `default` SA
    - _Requirements: 2.11_

- [x] 6. Checkpoint - ConfigMap, Secret, and ServiceAccount render
  - Run `helm lint helm/scrum-poker` and `helm template rel helm/scrum-poker | kubectl apply --dry-run=client -f -`; both must exit 0
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Deployment template
  - [x] 7.1 Create `helm/scrum-poker/templates/deployment.yaml` core structure
    - Include `scrum-poker.validate` first; emit exactly one `apps/v1` Deployment named from `scrum-poker.fullname` with `scrum-poker.labels`
    - `spec.replicas` from `replicaCount`; `spec.strategy.type` from `{{ .Values.deploymentStrategy.type | default "Recreate" }}` with no `rollingUpdate` block
    - `spec.selector.matchLabels` and `spec.template.metadata.labels` both from `scrum-poker.selectorLabels`
    - Exactly one container named `scrum-poker`; `image` as `{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}`; `imagePullPolicy` from `image.pullPolicy`
    - Exactly one container port: `name: http`, `protocol: TCP`, `containerPort` from `service.targetPort`
    - Pod annotation `checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}` — hash the rendered ConfigMap, not `.Values.config`, and deliberately exclude the Secret so an upgrade does not roll the pod on a freshly generated JWT value
    - `spec.template.spec.serviceAccountName` from `scrum-poker.serviceAccountName`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.14, 2.15_

  - [x] 7.2 Wire container environment into `deployment.yaml`
    - Exactly one `envFrom` entry of kind `configMapRef` naming `scrum-poker.configMapName`, placed before the `env` list
    - `env` always carries the `JWT_SECRET` `secretKeyRef` entry: when `auth.existingSecret` is empty, reference `scrum-poker.secretName` and key `JWT_SECRET`; when non-empty, reference `auth.existingSecret` with `default "JWT_SECRET" .Values.auth.existingSecretKey`
    - Append one `env` entry per `extraEnv` item after the `JWT_SECRET` entry, so an entry whose name matches a ConfigMap key takes precedence
    - With `extraEnv` empty the `env` list holds exactly that one `JWT_SECRET` entry and nothing else
    - _Requirements: 4.4, 4.7, 4.11, 5.3, 5.5_

  - [x] 7.3 Add readiness and liveness probes to `deployment.yaml`
    - Both `httpGet` with `path: /api/health` as a template **literal** (never interpolated with `config.basePath`), `port: http`, `scheme: HTTP`
    - Render `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`, `successThreshold`, `failureThreshold` each from its own identically named value, so overriding one leaves the other four at their defaults
    - Wrap each probe in its own independent `{{- if .Values.readinessProbe.enabled }}` / `{{- if .Values.livenessProbe.enabled }}`
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 6.8_

  - [x] 7.4 Add resources, security contexts, and the tmp volume to `deployment.yaml`
    - Render `resources` field-by-field under an outer `with` plus per-leaf `with` blocks, each value `quote`d, so an empty `resources` mapping omits the field entirely and a partially populated mapping omits only its missing leaves
    - Container `securityContext` and Pod `podSecurityContext` under `with` + `toYaml | nindent`, omitted for an empty mapping
    - Under a single `{{- if .Values.securityContext.readOnlyRootFilesystem }}` condition, render both the `tmp` `emptyDir` volume with `sizeLimit` from `tmpVolume.sizeLimit` and its matching `volumeMount` at `/tmp`, so the two can never appear apart
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7, 7.8_

  - [x] 7.5 Add optional scheduling and pull-secret blocks to `deployment.yaml`
    - `imagePullSecrets`, `podAnnotations`, `nodeSelector`, `tolerations`, `affinity` each via `{{- with … }}` + `toYaml | nindent`, so an empty or absent value omits the key rather than emitting `null` or `{}`
    - `toYaml` on the collection preserves supplied entry count and order for the `imagePullSecrets` and `tolerations` lists
    - Verify with `helm lint` and `helm template … | kubectl apply --dry-run=client -f -`
    - _Requirements: 2.9, 2.12, 2.13, 2.17_

  - [x] 7.6 Write property test for the image reference
    - **Property 4: The image reference is the exact concatenation of repository, colon, and resolved tag**
    - **Validates: Requirements 2.4, 2.15**

  - [x] 7.7 Write property test for configuration round-tripping into the container environment
    - **Property 7: Application configuration round-trips from values into the container environment**
    - **Validates: Requirements 4.2, 4.3, 4.6, 4.7**

  - [x] 7.8 Write property test for probe path invariance under base path
    - **Property 9: Probe paths are invariant under base path**
    - **Validates: Requirements 6.3**

  - [x] 7.9 Write property test for independent probe field and block control
    - **Property 10: Probe fields and probe blocks are independently controlled**
    - **Validates: Requirements 6.6, 6.7, 6.8**

  - [x] 7.10 Write property test for the tmp volume and mount pairing
    - **Property 11: The tmp volume and its mount appear and disappear together**
    - **Validates: Requirements 7.6, 7.7**

- [x] 8. Service template
  - [x] 8.1 Create `helm/scrum-poker/templates/service.yaml`
    - Include `scrum-poker.validate` first; one `v1` Service named from `scrum-poker.fullname` with `scrum-poker.labels`
    - `spec.type` from `{{ .Values.service.type | default "ClusterIP" }}`; `spec.selector` from `scrum-poker.selectorLabels` with no additional key
    - Exactly one `spec.ports` entry: `name: http`, `port` from `service.port`, `targetPort: http` as the **string** container-port name, `protocol: TCP`
    - `nodePort` emitted only when `service.type` is `NodePort` **and** `service.nodePort` holds a value, so a leftover value is silently ignored for other types
    - Exhaustive `sessionAffinity` branch: exactly `ClientIP` renders `ClientIP` plus `sessionAffinityConfig.clientIP.timeoutSeconds` from `service.sessionAffinityTimeoutSeconds`; anything else, including `None` and the empty string, renders `None`
    - `service.annotations` under `with`, omitting `metadata.annotations` for an empty mapping
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9, 3.11, 3.12_

  - [x] 8.2 Write unit tests for the Service type, affinity, and nodePort matrix
    - Each of the three `service.type` values; `ClientIP` / `None` / `""` affinity; `nodePort` present with `ClusterIP` asserting omission
    - _Requirements: 3.3, 3.7, 3.8, 3.11, 3.12_

- [x] 9. Checkpoint - workload and Service render and validate
  - `helm template rel helm/scrum-poker | kubectl apply --dry-run=client -f -` exits 0 and yields exactly one Deployment and one Service
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Ingress template
  - [x] 10.1 Create `helm/scrum-poker/templates/ingress.yaml` structure
    - Include `scrum-poker.validate` first, then wrap the whole document in `{{- if .Values.ingress.enabled }}` so a disabled ingress renders no resource
    - One `networking.k8s.io/v1` Ingress named from `scrum-poker.fullname` with `scrum-poker.labels`
    - One rule per `ingress.hosts` entry in supplied order, one path per `paths` entry in supplied order, `pathType` from the entry or `Prefix` when absent; omit the `host` field for an empty host so the rule matches every incoming host
    - Every backend names the `scrum-poker.fullname` Service and the **port number** from `service.port`
    - `spec.ingressClassName` under `{{- with .Values.ingress.className }}` so an empty value lets the cluster default IngressClass apply; `spec.tls` under `with` + `toYaml`, preserving order, `secretName`, and `hosts`
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6, 8.9, 8.12_

  - [x] 10.2 Implement the annotation merge in `ingress.yaml`
    - Build computed annotations into a dict: when `ingress.websocket.affinity` is true, set `nginx.ingress.kubernetes.io/affinity: cookie` and `nginx.ingress.kubernetes.io/session-cookie-name` from `ingress.websocket.cookieName`, falling back to `scrum-poker.fullname` when empty; when `config.preservePath` is false, set `nginx.ingress.kubernetes.io/rewrite-target: /`
    - Merge with `merge (deepCopy .Values.ingress.annotations) $ann` so an operator-supplied key always wins, and `deepCopy` prevents mutation of `.Values` leaking between invocations
    - Emit with `range $k, $v := $ann` for sorted, byte-stable key order
    - With `config.preservePath` true, `rewrite-target` appears only if the operator supplied it
    - Confirm the default `proxy-read-timeout` and `proxy-send-timeout` of `"3600"` survive the merge
    - _Requirements: 8.7, 8.8, 8.10, 8.11, 8.13_

  - [x] 10.3 Write property test for ingress annotation precedence
    - **Property 12: Operator ingress annotations take precedence over computed ones**
    - **Validates: Requirements 8.11, 8.13**

  - [x] 10.4 Write property test for collection count, order, and content preservation
    - **Property 6: Operator-supplied collections reach the manifest with count, order, and content preserved**
    - **Validates: Requirements 2.9, 2.12, 2.13, 8.4, 8.5, 8.9, 11.8**

  - [x] 10.5 Write property test for conditional-omission completeness
    - **Property 5: An empty or absent optional value omits its key rather than rendering empty or null**
    - **Validates: Requirements 2.17, 3.9, 3.11, 7.1, 7.3, 7.4, 7.8, 8.12**

  - [x] 10.6 Write property test for render well-formedness, determinism, and checksum fidelity
    - **Property 3: Rendering is well-formed, deterministic, and faithfully checksummed**
    - **Validates: Requirements 1.12, 2.10**
    - Pin `auth.jwtSecret` to a non-empty value before asserting byte-identical output, because `randAlphaNum 32` regenerates on every offline render

- [x] 11. Post-install notes
  - [x] 11.1 Create `helm/scrum-poker/templates/NOTES.txt` with its four branches
    - URL branch, ingress enabled: exactly one URL line, scheme `https` when `ingress.tls` holds at least one entry and `http` otherwise, host from `ingress.hosts[0].host`, base path appended verbatim so an empty `config.basePath` yields no trailing `/`
    - Host placeholder: when `ingress.hosts[0].host` is empty, render a literal placeholder in the host segment and state that the rendered rule matches every incoming host
    - Port-forward branch, ingress disabled: exactly one `kubectl port-forward --namespace {{ .Release.Namespace }} svc/{{ include "scrum-poker.fullname" . }} 8080:{{ .Values.service.port }}` line
    - Secret-read branch: only when `auth.existingSecret` is empty, the `kubectl get secret` command naming the rendered Secret and the release namespace
    - Replica warning: when `replicaCount > 1` and `service.sessionAffinity` is not `ClientIP`, warn that poker and retro session state lives in each pod's memory and that all participants of one session need one pod
    - _Requirements: 5.10, 9.4, 9.5, 9.8, 10.3_

  - [x] 11.2 Write property test for post-install URL composition
    - **Property 14: The post-install URL is composed without a trailing separator**
    - **Validates: Requirements 9.4, 9.8**

  - [x] 11.3 Write unit tests for the remaining notes branches
    - Port-forward line with `ingress.enabled=false`; secret-read line present with an empty `auth.existingSecret` and absent with a non-empty one; replica warning present and absent
    - _Requirements: 5.10, 9.5, 10.3_

- [x] 12. Values schema
  - [x] 12.1 Create `helm/scrum-poker/values.schema.json`
    - **Depends on `values.yaml` being final.** Requirement 11.1 demands the schema accept every default, so first reconcile `values.yaml` against every key the template tasks introduced, then write the schema and confirm a default-values render passes
    - Draft-07 `$schema`, `type: object`, top-level `required` listing exactly `image`, `service`, `config`, `replicaCount`; do **not** set top-level `additionalProperties: false`, which would break umbrella-chart values and global blocks
    - Constrain `image.repository` (string, 1–253), `image.tag` (string, ≤128), `image.pullPolicy` enum of exactly `Always`/`IfNotPresent`/`Never`
    - `service.type` enum of exactly `ClusterIP`/`NodePort`/`LoadBalancer`; `service.port` and `service.targetPort` integers 1–65535; `service.nodePort` typed `["integer","null"]` with bounds 30000–32767 applying while the value is an integer, so the `null` default passes; `service.sessionAffinityTimeoutSeconds` integer 1–86400
    - `config.nodeEnv` enum `production`/`development`; `config.basePath` string ≤64 with `"pattern": "^$|^/"`; `config.preservePath` boolean. Leave the trailing-slash rule to guard 7, where a dedicated message beats showing a regex
    - `auth.jwtSecret` ≤256, `auth.existingSecret` and `auth.existingSecretKey` ≤253, all strings
    - `securityContext` booleans plus `runAsUser` integer 1–65535; `resources` leaf strings with `minLength: 1`; `tmpVolume.sizeLimit` non-empty string
    - Apply one shared probe shape to both `readinessProbe` and `livenessProbe`: `enabled` boolean and the five integer fields bounded 1–3600
    - `additionalProperties: true` for `extraEnv` items, `podAnnotations`, `ingress.annotations`, `nodeSelector`, `affinity`
    - Verify `helm lint` and a default `helm template` both still exit 0
    - _Requirements: 4.8, 5.12, 6.9, 7.9, 10.2, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.8_

  - [x] 12.2 Write property test for schema rejection before rendering
    - **Property 16: Every schema constraint rejects before any template runs**
    - **Validates: Requirements 1.13, 4.8, 5.12, 6.9, 6.10, 7.9, 10.2, 11.7, 11.9, 11.10**

  - [x] 12.3 Write integration test for release revision preservation on rejected upgrade
    - Note the `helm list` revision, attempt an upgrade with schema-invalid values, assert a non-zero exit and an unchanged revision
    - _Requirements: 11.11_

- [x] 13. Cross-field validation guards
  - [x] 13.1 Implement guards 1–5 in `scrum-poker.validate`
    - Replace the task 2.2 stub body, preserving the empty-string return on success
    - Guard 1 `replicaCount` present, integer, ≥ 1; guard 2 `autoscaling.enabled` must be false; guard 3 `image.repository` non-empty; guard 4 `image.pullPolicy` in set; guard 5 `deploymentStrategy.type` in set
    - Every message starts with the values path, in the form `<values.path>: <what is wrong> (<what is permitted>)`
    - _Requirements: 2.16, 10.7, 10.8_

  - [x] 13.2 Implement guards 6–9 in `scrum-poker.validate`
    - Guard 6 `config.basePath` requires a leading `/`; guard 7 `config.basePath` rejects a trailing `/` when longer than one character; guard 8 every `extraEnv` entry requires a non-empty `name`; guard 9 `auth.jwtSecret` and `auth.existingSecret` are mutually exclusive, with a message naming both
    - Guards 6 and 7 must precede guard 13: a value like `scrum-poker` is both malformed and mismatched, and the smoke test expects the leading-slash message
    - _Requirements: 4.9, 4.10, 4.12, 5.11_

  - [x] 13.3 Implement guards 10–13 in `scrum-poker.validate`
    - Guard 10 `service.nodePort` within 30000–32767 when `service.type` is `NodePort`; guard 11 an enabled ingress requires at least one `ingress.hosts` entry; guard 12 every host entry requires at least one `paths` entry, message naming the zero-based index
    - Guard 13 base-path consistency, active only when `ingress.enabled` and `config.preservePath` are both true: normalise an empty `config.basePath` to `/` via `scrum-poker.normalizedBasePath`, strip exactly one trailing `/` from any ingress `path` longer than one character, compare by exact string equality, and `fail` on the first mismatch with a message naming `config.basePath`, the mismatched `path`, and the zero-based `ingress.hosts` index
    - Guard 12 precedes guard 13 because guard 13 iterates the `paths` lists guard 12 proves non-empty
    - Verify that `helm lint` and the default render still exit 0, and that each guard aborts with a non-zero status and zero manifests on stdout
    - _Requirements: 3.10, 8.14, 9.1, 9.2, 9.3, 9.6, 9.7_

  - [x] 13.4 Write property test for base path and ingress path agreement
    - **Property 13: Base path and ingress path agreement decides rendering**
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 13.5 Write property test for guard completeness and clean rejection
    - **Property 15: Every guard rejects cleanly, names its value, and emits nothing**
    - **Validates: Requirements 2.16, 3.10, 4.9, 4.10, 4.12, 5.11, 8.14, 9.6, 9.7, 10.7, 10.8**

- [x] 14. Checkpoint - the chart is complete and both gates pass
  - `helm lint helm/scrum-poker` reports zero errors and exits 0
  - `helm template rel helm/scrum-poker | kubectl apply --dry-run=client -f -` exits 0
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Chart smoke test
  - [x] 15.1 Create `tests/helm-smoke.test.sh` harness skeleton
    - Follow the structure of `tests/docker-smoke.test.sh`: `set -euo pipefail`, counter-incrementing helpers, one printed line per check naming the check and its outcome
    - Add a third `skip` outcome alongside `pass` and `fail`
    - Preflight: `helm` absent prints a message naming `helm` and exits 1 before any check; `kubectl` absent prints a message naming `kubectl`, sets a flag so every dry-run check records as skipped, and lets the remaining checks run
    - `fail` increments a counter and returns, so one broken check never aborts the run
    - Print passed, failed, and skipped totals; exit 0 only when failed is 0, otherwise 1
    - Every check reads only `helm/scrum-poker/` and opens no API-server connection
    - Mark the script executable
    - _Requirements: 12.1, 12.2, 12.12, 12.13, 12.16, 12.17, 12.18_

  - [x] 15.2 Add the default-render checks to `tests/helm-smoke.test.sh`
    - Check 1: `helm lint helm/scrum-poker` exits 0
    - Check 2: `helm template … | kubectl apply --dry-run=client -f -`, both exiting 0, recorded as skipped when `kubectl` is absent
    - Check 3: exactly one `kind: Deployment` and exactly one `kind: Service`
    - Check 4: exactly two occurrences of `/api/health`, one per probe
    - Check 5: container requests `100m`/`128Mi` and limits `500m`/`512Mi`
    - _Requirements: 12.3, 12.4, 12.5, 12.6, 12.7_

  - [x] 15.3 Add the ingress and negative-guard checks to `tests/helm-smoke.test.sh`
    - Check 6: `--set ingress.enabled=false` exits 0 with zero `kind: Ingress`
    - Check 7: `--set ingress.enabled=true` exits 0 with exactly one Ingress carrying `proxy-read-timeout: "3600"`
    - Check 8: `--set config.basePath=scrum-poker` exits non-zero with `config.basePath` in the captured output
    - Check 9: `--set config.preservePath=true,ingress.enabled=true,config.basePath=/other` exits non-zero with `config.basePath` in the captured output
    - Wrap both negative checks in the `if cmd; then fail … elif grep …; then pass … else fail …; fi` form so an expected non-zero status does not kill the script under `set -e`
    - _Requirements: 12.8, 12.9, 12.10, 12.11_

  - [x] 15.4 Add the truncation and documentation checks to `tests/helm-smoke.test.sh`
    - Check 10: render with a release name of at least 40 lowercase alphanumeric-and-hyphen characters; assert every `metadata.name` is at most 63 characters and ends in a non-hyphen character
    - Check 11: assert `helm/scrum-poker/README.md` exists and holds one values-table row per top-level key in `values.yaml`, extracting keys with a comment- and indentation-aware `^[a-zA-Z_][a-zA-Z0-9_]*:` match and printing a failure line naming the missing file or the undocumented key
    - Check 11 requires the README values table from task 16.2 to exist
    - Run the full script and confirm it exits 0
    - _Requirements: 12.14, 12.15_

- [x] 16. Operator documentation
  - [x] 16.1 Create `helm/scrum-poker/README.md` with structure, commands, and manifest parity
    - State the minimum supported Helm version `3.8` and Kubernetes version `1.19`
    - One `helm install` command naming a release-name placeholder and the local chart directory `helm/scrum-poker`, requiring no edit beyond the release name and namespace
    - One `helm upgrade`, one `helm uninstall`, and one `helm lint` command, each reusing that same placeholder and, for upgrade and lint, the local chart directory
    - State that the raw manifests under `k8s/` remain available and that chart defaults reproduce the same topology: one replica, `BASE_PATH=/scrum-poker`, `PRESERVE_PATH=true`, nginx ingress path `/scrum-poker`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.11_

  - [x] 16.2 Add the values table to `helm/scrum-poker/README.md`
    - Columns name, description, default; one row per configurable key including nested keys, names in dot notation, descriptions of 10–200 characters, defaults reproducing `values.yaml` verbatim with `""` for an empty string and `{}` for an empty mapping
    - Guarantee one row for every top-level key so the task 15.4 documentation check passes
    - _Requirements: 12.15, 13.5, 13.13_

  - [x] 16.3 Add the examples, WebSocket, JWT, scaling, and troubleshooting sections to `helm/scrum-poker/README.md`
    - Root-path example: `helm install` with `config.basePath=""`, the matching `ingress.hosts[0].paths[0].path` of `/`, and the resulting URL
    - Sub-path example: `config.basePath=/scrum-poker`, `config.preservePath=true`, the matching path `/scrum-poker`, and the resulting URL
    - WebSocket section naming each annotation, its chart default, and its observable effect on poker and retro updates, including that a proxy read or send timeout shorter than the connection idle period closes the connection
    - JWT section covering `auth.jwtSecret` through a chart-rendered Secret, `auth.existingSecret` precedence causing no Secret to render, `auth.existingSecretKey` defaulting to `JWT_SECRET`, random generation when both are empty, and the command to read the generated value
    - `replicaCount` section stating that session state lives in process memory, that `1` is the only supported value, and that horizontal scaling needs shared external state the application does not have
    - Troubleshooting entry for a blank page with failing assets, naming the `config.basePath` / ingress-path mismatch, naming `config.preservePath`, and stating the corrective value change
    - _Requirements: 10.4, 13.6, 13.7, 13.8, 13.9, 13.12_

- [x] 17. Final checkpoint - full validation
  - `helm lint helm/scrum-poker` reports zero errors; `helm template rel helm/scrum-poker | kubectl apply --dry-run=client -f -` exits 0; `bash tests/helm-smoke.test.sh` exits 0 with zero failures
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Chart publishing pipeline
  - `.github/workflows/helm-publish.yml` with three jobs: `lint` (lint, render, smoke test with kubectl masked off `PATH`, package, upload artifact), `publish-oci` (push to `oci://ghcr.io/siddhivinayak-sk/charts` with the built-in `GITHUB_TOKEN`), and `publish-pages` (`helm/chart-releaser-action` over `charts_dir: helm` onto the `gh-pages` branch)
  - Triggers: pushes to `main` and pull requests touching `helm/**`, published releases, and `workflow_dispatch` with an optional `chart_version` input; pull requests lint and package only
  - `skip_existing: true` and `mark_as_latest: false` on chart-releaser, so a push without a `Chart.yaml` version bump is a quiet no-op and a chart release never takes the repository's "Latest release" badge
  - `helm/scrum-poker/artifacthub-repo.yml` holding the Artifact Hub ownership metadata, with `repositoryID` left as a placeholder to be filled from the control panel
  - Chart README gains an `### Install from a published chart repository` subsection; the root README gains a `### Helm Chart` section covering both install paths, values customization, the enforced constraints, and the release procedure
  - One-time manual setup documented in the root README and not performed by CI: create the orphan `gh-pages` branch, enable GitHub Pages on it, make the GHCR package public, and deliver `artifacthub-repo.yml` to each repository

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster first install; the chart itself is complete after task 13.3 and documented after task 16.3.
- `tests/k8s-smoke.test.sh` is out of scope. It references `k8s/deployment.yaml` and `k8s/service.yaml`, which do not exist, and shares no code or fixtures with the chart test path. Realigning it to `k8s/k8s.yaml` is a separate follow-up.
- `scrum-poker.validate` is stubbed in task 2.2 and implemented in tasks 13.1–13.3. Every template file includes it as its first action from the moment it is created, so no guard can be bypassed by a resource being disabled.
- `values.schema.json` (task 12.1) must come after every template has fixed the shape of `values.yaml`, because Requirement 11.1 requires the schema to accept every declared default.
- The three `lookup`-dependent criteria (5.7, 5.8, 11.11) are integration tests needing a live cluster; `lookup` returns an empty map under `helm template` and client-side `helm lint`.
- Property tests pin `auth.jwtSecret` to a non-empty value whenever they assert byte-identical output, because `randAlphaNum 32` regenerates on every offline render.
- Verification throughout uses the locally available `helm v3.15.1` and `kubectl v1.35.0`. The chart needs no build step; the only `package.json` introduced is the property-harness one at `tests/helm/`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3"] },
    { "id": 4, "tasks": ["2.4", "2.5", "3.1", "4.1", "5.1"] },
    { "id": 5, "tasks": ["3.2", "4.2", "5.2", "7.1"] },
    { "id": 6, "tasks": ["4.3", "4.4", "7.2", "8.1"] },
    { "id": 7, "tasks": ["7.3", "8.2"] },
    { "id": 8, "tasks": ["7.4"] },
    { "id": 9, "tasks": ["7.5"] },
    { "id": 10, "tasks": ["7.6", "7.7", "7.8", "7.9", "7.10", "10.1"] },
    { "id": 11, "tasks": ["10.2"] },
    { "id": 12, "tasks": ["10.3", "10.4", "10.5", "10.6", "11.1"] },
    { "id": 13, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 14, "tasks": ["12.2", "12.3", "13.1"] },
    { "id": 15, "tasks": ["13.2"] },
    { "id": 16, "tasks": ["13.3"] },
    { "id": 17, "tasks": ["13.4", "13.5", "15.1"] },
    { "id": 18, "tasks": ["15.2", "16.1"] },
    { "id": 19, "tasks": ["15.3", "16.2"] },
    { "id": 20, "tasks": ["15.4", "16.3"] }
  ]
}
```
