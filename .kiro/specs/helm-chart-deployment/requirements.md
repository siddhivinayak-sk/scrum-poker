# Requirements Document

## Introduction

This feature packages the Scrum Poker application as a reusable Helm chart so that operators can install, upgrade, and uninstall the application on a Kubernetes cluster with a single command and configure it through `values.yaml` instead of editing raw manifests.

The application ships as a single container image (`siddhivinayaksk/scrum-pocker`) that serves the Angular client, the Express REST API, and two WebSocket endpoints (poker and retro) from one process on port 3000. The existing raw manifests (`k8s/k8s.yaml`, `k8s/ingress.yaml`) encode a working deployment topology: one replica, `BASE_PATH=/scrum-poker`, `PRESERVE_PATH=true`, nginx ingress at `/scrum-poker`, probes against `/api/health`, and fixed CPU/memory requests and limits. The Helm chart reproduces that topology as the default configuration and makes each element configurable.

Analysis of the current codebase identified four constraints the chart must respect:

1. **Session state is in-process.** `SessionRegistry` and `RetroSessionRegistry` hold all poker and retro session state in memory inside a single Node.js process. Two replicas would place participants of the same session in different pods with no shared state, so the chart defaults to one replica and surfaces this constraint to the operator.
2. **The JWT signing secret falls back to a hard-coded value.** `auth-service.ts` uses `process.env.JWT_SECRET || 'scrum-poker-secret-key'`. The chart must supply `JWT_SECRET` from a Kubernetes Secret rather than relying on the built-in fallback.
3. **`BASE_PATH` and the ingress path are coupled.** The server rewrites `<base href>`, rewrites asset URLs, and mounts its router based on `BASE_PATH` and `PRESERVE_PATH`. A mismatch between the ingress path and `BASE_PATH` produces a blank page with 404 assets, so the chart derives the two values from a single source and validates agreement.
4. **WebSocket upgrades traverse the ingress.** Browser clients open `/ws`-style and `/retro` WebSocket connections through the same host and path prefix as the HTTP traffic, so the ingress template must carry timeout and upgrade-friendly annotations.

Scope covers the chart source under `helm/scrum-poker/`, its templates (Deployment, Service, Ingress, ConfigMap, Secret, ServiceAccount, helpers, and post-install notes), a JSON values schema, a chart-level smoke test, and operator documentation. The chart also provides a writable `emptyDir` volume at `/tmp` sized by `tmpVolume.sizeLimit` so that the container runs with a read-only root filesystem, and a `service.sessionAffinityTimeoutSeconds` value that bounds `ClientIP` session affinity. Application source code changes are out of scope.

## Glossary

- **Helm_Chart**: The chart directory `helm/scrum-poker/` containing `Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, and `README.md`.
- **Chart_Metadata**: The contents of `Chart.yaml`, including `apiVersion`, `name`, `description`, `type`, `version`, and `appVersion`.
- **Values_File**: The `values.yaml` file in the Helm_Chart that declares every configurable input and its default value.
- **Values_Schema**: The `values.schema.json` file in the Helm_Chart that constrains the types and permitted values of Values_File entries, enforced by Helm during `install`, `upgrade`, `lint`, and `template`.
- **Deployment_Template**: The template `templates/deployment.yaml` that renders a Kubernetes `apps/v1` Deployment.
- **Service_Template**: The template `templates/service.yaml` that renders a Kubernetes `v1` Service.
- **Ingress_Template**: The template `templates/ingress.yaml` that renders a Kubernetes `networking.k8s.io/v1` Ingress.
- **ConfigMap_Template**: The template `templates/configmap.yaml` that renders a Kubernetes `v1` ConfigMap holding non-secret application environment values.
- **Secret_Template**: The template `templates/secret.yaml` that renders a Kubernetes `v1` Secret holding the JWT signing key.
- **ServiceAccount_Template**: The template `templates/serviceaccount.yaml` that renders a Kubernetes `v1` ServiceAccount used by the rendered Pod.
- **Notes_Template**: The template `templates/NOTES.txt` that renders post-install guidance displayed by Helm.
- **Chart_Readme**: The file `helm/scrum-poker/README.md` containing operator-facing installation and configuration documentation for the Helm_Chart.
- **Helpers_Template**: The template `templates/_helpers.tpl` that defines named templates for resource names, labels, and selector labels.
- **Scrum_Poker_Container**: The single application container in the rendered Deployment, running the image `{{ .Values.image.repository }}:{{ .Values.image.tag }}` and listening on the container port.
- **Health_Endpoint**: The HTTP path `/api/health`, served by the application at a fixed location independent of `BASE_PATH`, returning HTTP 200 with body `{"status":"ok"}` when the process is healthy.
- **Base_Path**: The public URL prefix the browser sees, passed to Scrum_Poker_Container as the `BASE_PATH` environment variable (example value `/scrum-poker`).
- **Preserve_Path**: A boolean passed to Scrum_Poker_Container as the `PRESERVE_PATH` environment variable, set to `"true"` when the ingress forwards the full request path including Base_Path.
- **Jwt_Secret**: The JWT signing key consumed by the application as the `JWT_SECRET` environment variable.
- **Tmp_Volume**: The `emptyDir` volume named `tmp`, sized by the value `tmpVolume.sizeLimit`, mounted on Scrum_Poker_Container at the container path `/tmp` so that the Node.js process writes temporary files while the root filesystem stays read-only.
- **Websocket_Annotations**: The set of ingress controller annotations that permit long-lived WebSocket connections, comprising `nginx.ingress.kubernetes.io/proxy-read-timeout`, `nginx.ingress.kubernetes.io/proxy-send-timeout`, and, where `ingress.websocket.affinity` equals `true`, `nginx.ingress.kubernetes.io/affinity` and `nginx.ingress.kubernetes.io/session-cookie-name`.
- **Chart_Linter**: The `helm lint` command executed against the Helm_Chart.
- **Template_Renderer**: The `helm template` command executed against the Helm_Chart.
- **Manifest_Validator**: The `kubectl apply --dry-run=client` command executed against output produced by Template_Renderer.
- **Helm_Smoke_Test**: The script `tests/helm-smoke.test.sh` that runs Chart_Linter, Template_Renderer, and Manifest_Validator checks without requiring a cluster connection.
- **Operator**: A person who installs, upgrades, or uninstalls the Helm_Chart on a Kubernetes cluster.
- **Release_Name**: The Helm release name supplied by the Operator at install time, available to templates as `.Release.Name`.

## Requirements

### Requirement 1: Chart Structure and Metadata

**User Story:** As an operator, I want a well-formed chart directory with complete metadata, so that I can discover, version, and install the chart with standard Helm tooling.

#### Acceptance Criteria

1. THE Helm_Chart SHALL reside at the repository-relative path `helm/scrum-poker/`.
2. THE Helm_Chart SHALL contain the files `Chart.yaml`, `values.yaml`, `values.schema.json`, `README.md`, `templates/_helpers.tpl`, `templates/deployment.yaml`, `templates/service.yaml`, `templates/ingress.yaml`, `templates/configmap.yaml`, `templates/secret.yaml`, `templates/serviceaccount.yaml`, and `templates/NOTES.txt`, and each of these files SHALL be non-empty.
3. THE Chart_Metadata SHALL set `apiVersion` to `v2`, `name` to `scrum-poker`, and `type` to `application`.
4. THE Chart_Metadata SHALL set `version` to a semantic version string of the form `MAJOR.MINOR.PATCH`, where each of MAJOR, MINOR, and PATCH is a non-negative integer of 1 to 4 digits without leading zeros and without any pre-release or build-metadata suffix, and SHALL set the initial value to `0.1.0`.
5. THE Chart_Metadata SHALL set `appVersion` to a quoted string of 1 to 128 characters identifying the application image version, with the initial value `"latest"`.
6. THE Chart_Metadata SHALL include a `description` field of at least 20 characters and at most 200 characters.
7. WHEN Chart_Linter runs against the Helm_Chart with default values, THE Chart_Linter SHALL report zero errors and exit with status code 0, with no constraint placed on the number of informational or warning messages.
8. THE Helpers_Template SHALL define the named templates `scrum-poker.name`, `scrum-poker.fullname`, `scrum-poker.chart`, `scrum-poker.labels`, `scrum-poker.selectorLabels`, and `scrum-poker.serviceAccountName`.
9. THE Helpers_Template SHALL truncate every rendered resource name produced by `scrum-poker.fullname` to a maximum of 63 characters and SHALL remove all trailing hyphen characters from the truncated result so that the final character is alphanumeric.
10. THE Helm_Chart SHALL apply the labels `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/version`, `app.kubernetes.io/managed-by`, and `helm.sh/chart` to every rendered resource through the `scrum-poker.labels` named template, and each applied label value SHALL be a non-empty string of at most 63 characters.
11. THE Helm_Chart SHALL restrict the `scrum-poker.selectorLabels` named template to the labels `app.kubernetes.io/name` and `app.kubernetes.io/instance`, and rendering the chart with any two different `version` or `appVersion` metadata values and otherwise identical inputs SHALL produce byte-identical selector label blocks.
12. WHEN Template_Renderer renders the Helm_Chart with default values, THE Template_Renderer SHALL emit parseable YAML for every file under `templates/` and SHALL exit with status code 0.
13. IF supplied values violate `values.schema.json`, THEN THE Helm_Chart SHALL reject the install or upgrade operation with a non-zero exit status and an error message identifying the rejected value path, and SHALL leave existing cluster resources unchanged.

---

### Requirement 2: Deployment Template

**User Story:** As an operator, I want the chart to render a Deployment for the Scrum Poker container, so that the application runs as a managed workload on my cluster.

#### Acceptance Criteria

1. WHEN the chart is rendered, THE Deployment_Template SHALL emit exactly one resource with `apiVersion: apps/v1` and `kind: Deployment`.
2. WHEN the chart is rendered, THE Deployment_Template SHALL set `metadata.name` of the Deployment to the output of the `scrum-poker.fullname` named template, which includes Release_Name and is at most 63 characters long.
3. WHEN the chart is rendered, THE Deployment_Template SHALL render exactly one entry in `spec.template.spec.containers` and SHALL set that entry's `name` to `scrum-poker`.
4. WHILE `image.tag` is a non-empty string, WHEN the chart is rendered, THE Deployment_Template SHALL set the container `image` to the value of `image.repository`, followed by the character `:`, followed by the value of `image.tag`, with no additional characters.
5. WHEN the chart is rendered, THE Deployment_Template SHALL set the container `imagePullPolicy` to the value of `image.pullPolicy`, accepting the values `Always`, `IfNotPresent`, and `Never`.
6. WHEN the chart is rendered, THE Deployment_Template SHALL set `spec.replicas` to the value of `replicaCount`, accepting integers of 1 or greater.
7. WHEN the chart is rendered, THE Deployment_Template SHALL declare exactly one container port with `name: http`, `protocol: TCP`, and `containerPort` set to the value of `service.targetPort`, accepting integers from 1 through 65535 inclusive.
8. WHEN the chart is rendered, THE Deployment_Template SHALL set `spec.selector.matchLabels` and `spec.template.metadata.labels` to the same key/value set produced by the `scrum-poker.selectorLabels` named template.
9. WHERE `imagePullSecrets` contains one or more entries, WHEN the chart is rendered, THE Deployment_Template SHALL render `spec.template.spec.imagePullSecrets` with the same number of entries as supplied, in the order supplied, each entry's name matching the supplied name.
10. THE Deployment_Template SHALL set the Pod template annotation `checksum/config` to a value derived from the complete rendered ConfigMap content, such that the value is identical for two renderings with identical ConfigMap content and differs for two renderings whose ConfigMap content differs in any character.
11. WHEN the chart is rendered, THE Deployment_Template SHALL set `spec.template.spec.serviceAccountName` to the output of the `scrum-poker.serviceAccountName` named template.
12. WHERE `podAnnotations` contains one or more entries, WHEN the chart is rendered, THE Deployment_Template SHALL render each supplied key/value pair into `spec.template.metadata.annotations` with keys and values unchanged.
13. WHERE `nodeSelector`, `tolerations`, or `affinity` contains one or more entries, WHEN the chart is rendered, THE Deployment_Template SHALL render each supplied value unchanged into `spec.template.spec.nodeSelector`, `spec.template.spec.tolerations`, and `spec.template.spec.affinity` respectively.
14. WHEN the chart is rendered, THE Deployment_Template SHALL set `spec.strategy.type` to the value of `deploymentStrategy.type`, accepting the values `Recreate` and `RollingUpdate`, and SHALL use `Recreate` when `deploymentStrategy.type` is empty or not supplied, so that an in-memory session holder is replaced rather than duplicated during an upgrade.
15. IF `image.tag` is an empty string or is not supplied, THEN THE Deployment_Template SHALL set the container `image` to the value of `image.repository`, followed by the character `:`, followed by the value of `Chart.appVersion`.
16. IF `image.repository` is empty or not supplied, or `replicaCount` is not an integer of 1 or greater, or `image.pullPolicy` or `deploymentStrategy.type` holds a value outside its accepted set, THEN THE Deployment_Template SHALL fail the rendering, SHALL return an error message identifying the offending value name, and SHALL emit no Deployment resource.
17. WHERE `imagePullSecrets`, `podAnnotations`, `nodeSelector`, `tolerations`, or `affinity` contains zero entries or is not supplied, WHEN the chart is rendered, THE Deployment_Template SHALL omit the corresponding field from the rendered Deployment rather than emitting an empty or null field.

---

### Requirement 3: Service Template

**User Story:** As an operator, I want the chart to render a Service in front of the application pod, so that in-cluster clients and the ingress controller reach the application through a stable address.

#### Acceptance Criteria

1. THE Service_Template SHALL render exactly one resource with `apiVersion: v1` and `kind: Service`.
2. THE Service_Template SHALL name the rendered Service using the `scrum-poker.fullname` named template and SHALL apply the `scrum-poker.labels` named template to the Service metadata labels.
3. THE Service_Template SHALL set `spec.type` from the value `service.type`, SHALL default that value to `ClusterIP`, and SHALL accept only the values `ClusterIP`, `NodePort`, and `LoadBalancer`.
4. THE Service_Template SHALL render a `spec.ports` list holding exactly one entry, with `name` set to `http`, `port` set to the integer value of `service.port`, `targetPort` set to the string `http` matching the container port name declared by Deployment_Template, and `protocol` set to `TCP`.
5. THE Values_File SHALL default `service.port` to the integer `80` and `service.targetPort` to the integer `3000`, matching the topology in `k8s/k8s.yaml`, and SHALL constrain each value to the inclusive range 1 to 65535.
6. THE Service_Template SHALL set `spec.selector` to the output of the `scrum-poker.selectorLabels` named template and SHALL render no additional selector key.
7. WHERE `service.type` equals `NodePort` AND `service.nodePort` holds a non-null integer within the inclusive range 30000 to 32767, THE Service_Template SHALL set the port entry `nodePort` to that value.
8. WHERE `service.sessionAffinity` equals `ClientIP`, THE Service_Template SHALL set `spec.sessionAffinity` to `ClientIP` and SHALL set `spec.sessionAffinityConfig.clientIP.timeoutSeconds` from the value `service.sessionAffinityTimeoutSeconds`, defaulted to `10800` and constrained to the inclusive range 1 to 86400, so that repeated connections from one client reach the same pod.
9. WHERE `service.annotations` contains at least one entry, THE Service_Template SHALL render every supplied entry into the Service metadata annotations, and WHERE `service.annotations` equals an empty mapping, THE Service_Template SHALL omit the `metadata.annotations` field.
10. IF `service.type` equals `NodePort` AND `service.nodePort` holds a value outside the inclusive range 30000 to 32767, THEN THE Helm_Chart SHALL fail rendering with a message naming `service.nodePort` and stating the permitted range, and SHALL render no Service resource.
11. WHERE `service.type` differs from `NodePort`, THE Service_Template SHALL omit `nodePort` from the rendered port entry regardless of the value held by `service.nodePort`.
12. WHERE `service.sessionAffinity` holds an empty value or equals `None`, THE Service_Template SHALL set `spec.sessionAffinity` to `None`.

---

### Requirement 4: Application Configuration and Environment Variables

**User Story:** As an operator, I want to set the application's runtime environment through chart values, so that I can adapt the deployment to my cluster without rebuilding the image.

#### Acceptance Criteria

1. THE ConfigMap_Template SHALL render a resource with `apiVersion: v1` and `kind: ConfigMap`, named using the `scrum-poker.fullname` named template with the suffix `-config`.
2. THE ConfigMap_Template SHALL render exactly four `data` keys, `PORT`, `NODE_ENV`, `BASE_PATH`, and `PRESERVE_PATH`, setting `PORT` to the decimal digits of `service.targetPort`, `NODE_ENV` to the value of `config.nodeEnv`, `BASE_PATH` to the value of `config.basePath`, and `PRESERVE_PATH` to `true` when `config.preservePath` holds `true` and to `false` when `config.preservePath` holds `false`.
3. THE ConfigMap_Template SHALL enclose every rendered `data` value in double quotes, so that the integer value of `service.targetPort` renders as quoted decimal digits and the boolean value of `config.preservePath` renders as `"true"` or `"false"`.
4. THE Deployment_Template SHALL render exactly one `envFrom` entry on Scrum_Poker_Container, of kind `configMapRef`, naming the ConfigMap rendered by ConfigMap_Template, so that all four ConfigMap keys reach the container.
5. THE Values_File SHALL default `config.nodeEnv` to `production`, `config.basePath` to `/scrum-poker`, and `config.preservePath` to `true`.
6. WHERE `config.basePath` equals an empty string, THE ConfigMap_Template SHALL render the `BASE_PATH` key with an empty quoted string value and SHALL NOT omit the key, so that the application serves the application at the cluster root.
7. WHERE `extraEnv` contains at least one entry, THE Deployment_Template SHALL render one container `env` list item per supplied entry, carrying that entry's `name` and `value` fields, and SHALL place the `env` list after the `envFrom` reference so that an entry whose `name` matches a ConfigMap key takes precedence.
8. THE Values_Schema SHALL constrain `config.preservePath` to the boolean type, `config.nodeEnv` to one of the string values `production` or `development`, and `config.basePath` to a string of at most 64 characters that holds either an empty value or a value beginning with the `/` character.
9. IF `config.basePath` holds a non-empty value that omits a leading `/` character, THEN THE Helm_Chart SHALL fail rendering with a non-zero exit status, SHALL emit no manifest output, and SHALL report a message naming `config.basePath` and stating that the value requires a leading `/`.
10. IF `config.basePath` holds a value ending with a `/` character and the value length exceeds one character, THEN THE Helm_Chart SHALL fail rendering with a non-zero exit status, SHALL emit no manifest output, and SHALL report a message naming `config.basePath` and stating that the value rejects a trailing `/`.
11. WHERE `extraEnv` contains zero entries, THE Deployment_Template SHALL render a container `env` list holding exactly one entry, that entry being the `JWT_SECRET` entry required by criterion 5.3 or criterion 5.5, and SHALL render no additional `env` entry.
12. IF an entry in `extraEnv` omits a `name` field or holds a `name` field equal to an empty string, THEN THE Helm_Chart SHALL fail rendering with a non-zero exit status, SHALL emit no manifest output, and SHALL report a message naming `extraEnv` and stating that each entry requires a non-empty `name`.

---

### Requirement 5: JWT Secret Management

**User Story:** As an operator, I want the JWT signing key supplied through a Kubernetes Secret, so that authentication tokens on my deployment are signed with a key I control.

#### Acceptance Criteria

1. WHERE `auth.existingSecret` equals an empty string, THE Secret_Template SHALL render exactly one resource with `apiVersion: v1`, `kind: Secret`, and `type: Opaque`, named using the `scrum-poker.fullname` named template with the suffix `-secret`.
2. THE Secret_Template SHALL store the resolved Jwt_Secret under exactly one data key named `JWT_SECRET`, encoded as base64 through the `b64enc` function, and SHALL render no additional data key.
3. WHERE `auth.existingSecret` equals an empty string, THE Deployment_Template SHALL inject `JWT_SECRET` into Scrum_Poker_Container as an environment variable sourced from a `secretKeyRef` referencing the Secret rendered by Secret_Template and the key `JWT_SECRET`.
4. WHERE `auth.existingSecret` holds a non-empty value, THE Secret_Template SHALL render zero resources.
5. WHERE `auth.existingSecret` holds a non-empty value, THE Deployment_Template SHALL inject `JWT_SECRET` into Scrum_Poker_Container from a `secretKeyRef` naming the Secret held in `auth.existingSecret` and the key held in `auth.existingSecretKey`, and SHALL use `JWT_SECRET` as that key when `auth.existingSecretKey` equals an empty string.
6. WHERE `auth.jwtSecret` equals an empty string AND `auth.existingSecret` equals an empty string AND no Secret with the rendered name exists in the release namespace, THE Secret_Template SHALL generate a Jwt_Secret of exactly 32 characters drawn from the alphanumeric set of upper-case letters, lower-case letters, and digits.
7. WHEN an Operator runs `helm upgrade` on a release while `auth.jwtSecret` equals an empty string AND `auth.existingSecret` equals an empty string AND a Secret with the rendered name holding a non-empty `JWT_SECRET` key exists in the release namespace, THE Secret_Template SHALL render that existing `JWT_SECRET` value unchanged so that tokens issued before the upgrade remain verifiable after it.
8. WHERE `auth.jwtSecret` holds a non-empty value, THE Secret_Template SHALL render that value as the Jwt_Secret in preference to any value already stored in the release namespace.
9. THE Values_File SHALL default `auth.jwtSecret` to an empty string, `auth.existingSecret` to an empty string, and `auth.existingSecretKey` to `JWT_SECRET`, and SHALL carry a comment above `auth.jwtSecret` stating that an empty value triggers generation of a 32-character random value at install time.
10. WHERE `auth.existingSecret` equals an empty string, THE Notes_Template SHALL display the `kubectl get secret` command that reads the `JWT_SECRET` key of the rendered Secret, including the rendered Secret name and the release namespace.
11. IF `auth.jwtSecret` holds a non-empty value AND `auth.existingSecret` holds a non-empty value, THEN THE Helm_Chart SHALL fail rendering before producing any manifest, with a message naming both `auth.jwtSecret` and `auth.existingSecret` and stating that the two inputs are mutually exclusive.
12. THE Values_Schema SHALL constrain `auth.jwtSecret`, `auth.existingSecret`, and `auth.existingSecretKey` to the string type, SHALL limit `auth.jwtSecret` to at most 256 characters, and SHALL limit `auth.existingSecret` and `auth.existingSecretKey` to at most 253 characters each.

---

### Requirement 6: Health Probes

**User Story:** As an operator, I want readiness and liveness probes configured against the health endpoint, so that Kubernetes routes traffic only to a ready pod and restarts an unresponsive pod.

#### Acceptance Criteria

1. THE Deployment_Template SHALL configure an `httpGet` readiness probe on Scrum_Poker_Container with `path` set to the Health_Endpoint value `/api/health`, `port` set to the container port name `http`, and `scheme` set to `HTTP`.
2. THE Deployment_Template SHALL configure an `httpGet` liveness probe on Scrum_Poker_Container with `path` set to the Health_Endpoint value `/api/health`, `port` set to the container port name `http`, and `scheme` set to `HTTP`.
3. THE Deployment_Template SHALL render both probe paths as the literal string `/api/health` for every value of `config.basePath`, including a non-empty prefix value such as `/scrum-poker` and an empty string.
4. THE Values_File SHALL default `readinessProbe` to `enabled: true`, `initialDelaySeconds: 5`, `periodSeconds: 10`, `timeoutSeconds: 3`, `successThreshold: 1`, and `failureThreshold: 3`.
5. THE Values_File SHALL default `livenessProbe` to `enabled: true`, `initialDelaySeconds: 10`, `periodSeconds: 15`, `timeoutSeconds: 3`, `successThreshold: 1`, and `failureThreshold: 3`.
6. THE Deployment_Template SHALL render the probe fields `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`, `successThreshold`, and `failureThreshold` from the identically named values under `readinessProbe` and `livenessProbe` respectively, and SHALL leave the rendered value of every other probe field unchanged when an Operator overrides one field.
7. WHERE `readinessProbe.enabled` equals `false`, THE Deployment_Template SHALL render no `readinessProbe` field in the Scrum_Poker_Container specification and SHALL retain the `livenessProbe` field as configured.
8. WHERE `livenessProbe.enabled` equals `false`, THE Deployment_Template SHALL render no `livenessProbe` field in the Scrum_Poker_Container specification and SHALL retain the `readinessProbe` field as configured.
9. THE Values_Schema SHALL constrain `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`, `successThreshold`, and `failureThreshold` under both `readinessProbe` and `livenessProbe` to integers between 1 and 3600 inclusive, and SHALL constrain `readinessProbe.enabled` and `livenessProbe.enabled` to the boolean type.
10. IF an Operator supplies a probe field value that conflicts with the constraints in criterion 6.9, THEN THE Helm_Chart SHALL reject the `install`, `upgrade`, or `template` operation with a validation error naming the conflicting probe property path and SHALL render no resources.

---

### Requirement 7: Resource Requests and Limits

**User Story:** As an operator, I want CPU and memory requests and limits set by default, so that the application receives a predictable share of cluster capacity.

#### Acceptance Criteria

1. THE Deployment_Template SHALL render `resources.requests.cpu`, `resources.requests.memory`, `resources.limits.cpu`, and `resources.limits.memory` on Scrum_Poker_Container from the corresponding entries under the value `resources`, and SHALL omit from the rendered container specification every one of those four entries that holds no value.
2. THE Values_File SHALL default `resources.requests.cpu` to `100m`, `resources.requests.memory` to `128Mi`, `resources.limits.cpu` to `500m`, and `resources.limits.memory` to `512Mi`, matching the values in `k8s/k8s.yaml`, and THE Deployment_Template SHALL render each of the four values as a quoted string.
3. WHERE `resources` equals an empty mapping or holds no value, THE Deployment_Template SHALL omit the `resources` field entirely from the rendered container specification so that cluster defaults apply.
4. THE Deployment_Template SHALL render the container-level `securityContext` on Scrum_Poker_Container from the value `securityContext`, and SHALL omit that field from the rendered container specification when `securityContext` equals an empty mapping or holds no value.
5. THE Values_File SHALL default `securityContext` to exactly the five entries `runAsNonRoot: true`, `runAsUser: 1000`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and `capabilities.drop: [ALL]`.
6. WHERE `securityContext.readOnlyRootFilesystem` equals `true`, THE Deployment_Template SHALL render Tmp_Volume as an `emptyDir` volume named `tmp` whose `sizeLimit` comes from the value `tmpVolume.sizeLimit`, defaulted in the Values_File to `64Mi`, and SHALL mount Tmp_Volume on Scrum_Poker_Container at the container path `/tmp` so that the Node.js process writes temporary files successfully.
7. WHERE `securityContext.readOnlyRootFilesystem` differs from `true`, THE Deployment_Template SHALL omit both Tmp_Volume and its container mount from the rendered Pod specification.
8. THE Deployment_Template SHALL render the Pod-level security context from the value `podSecurityContext`, defaulted in the Values_File to an empty mapping, and SHALL omit that field from the rendered Pod specification while `podSecurityContext` equals an empty mapping.
9. THE Values_Schema SHALL constrain `resources.requests.cpu`, `resources.requests.memory`, `resources.limits.cpu`, `resources.limits.memory`, and `tmpVolume.sizeLimit` to non-empty strings, and SHALL constrain `securityContext.runAsNonRoot`, `securityContext.allowPrivilegeEscalation`, and `securityContext.readOnlyRootFilesystem` to the boolean type and `securityContext.runAsUser` to an integer between 1 and 65535 inclusive.

---

### Requirement 8: Ingress with WebSocket Support

**User Story:** As an operator, I want an optional ingress that carries both HTTP and WebSocket traffic, so that users reach the application from outside the cluster and real-time updates continue to work.

#### Acceptance Criteria

1. WHERE `ingress.enabled` equals `true`, THE Ingress_Template SHALL render exactly one resource with `apiVersion: networking.k8s.io/v1` and `kind: Ingress`, named using the `scrum-poker.fullname` named template and carrying the labels produced by the `scrum-poker.labels` named template.
2. WHERE `ingress.enabled` equals `false`, THE Ingress_Template SHALL render no resource.
3. THE Values_File SHALL default `ingress.enabled` to `true`, `ingress.className` to `nginx`, `ingress.hosts` to a single entry whose `host` holds an empty string, that entry's `paths` to a single entry holding `path: /scrum-poker` and `pathType: Prefix`, `ingress.tls` to an empty list, `ingress.websocket.affinity` to `false`, and `ingress.websocket.cookieName` to `scrum-poker-affinity`.
4. THE Ingress_Template SHALL set the backend of every rendered path to the Service named by the `scrum-poker.fullname` named template and to the port number held in `service.port`.
5. THE Ingress_Template SHALL render one rule per entry in `ingress.hosts` in the supplied order and one path per entry in the `paths` list of each host in the supplied order, using the `pathType` value held in each path entry and the value `Prefix` for a path entry that holds no `pathType` value.
6. WHERE an entry in `ingress.hosts` holds an empty `host` value, THE Ingress_Template SHALL render the rule without a `host` field so that the rule matches every incoming host.
7. THE Values_File SHALL default `ingress.annotations` to include `nginx.ingress.kubernetes.io/proxy-read-timeout` and `nginx.ingress.kubernetes.io/proxy-send-timeout`, each rendered as the quoted string `"3600"`, so that a WebSocket connection remains open through 3600 seconds of idle time.
8. WHERE `ingress.websocket.affinity` equals `true`, THE Ingress_Template SHALL add the annotation `nginx.ingress.kubernetes.io/affinity` with the value `cookie` and the annotation `nginx.ingress.kubernetes.io/session-cookie-name` with the value held in `ingress.websocket.cookieName`, substituting the name produced by the `scrum-poker.fullname` named template where `ingress.websocket.cookieName` holds an empty string.
9. WHERE `ingress.tls` contains at least one entry, THE Ingress_Template SHALL render a `spec.tls` list holding one element per supplied entry in the supplied order, each element carrying the `secretName` and the `hosts` list of that entry unchanged.
10. WHERE `ingress.enabled` equals `true` AND `config.preservePath` equals `false`, THE Ingress_Template SHALL render the annotation `nginx.ingress.kubernetes.io/rewrite-target` with the value `/` so that the ingress strips Base_Path before forwarding the request.
11. THE Ingress_Template SHALL render the annotations produced by criteria 8.8 and 8.10 first and SHALL render every entry in `ingress.annotations` afterwards, so that an entry in `ingress.annotations` replaces any annotation holding the same key.
12. WHERE `ingress.enabled` equals `true`, THE Ingress_Template SHALL set `spec.ingressClassName` to the value held in `ingress.className`, and SHALL omit the `spec.ingressClassName` field where `ingress.className` holds an empty string so that the cluster default IngressClass applies.
13. WHERE `ingress.enabled` equals `true` AND `config.preservePath` equals `true`, THE Ingress_Template SHALL omit the annotation `nginx.ingress.kubernetes.io/rewrite-target` unless `ingress.annotations` holds that key, so that the ingress forwards the full request path including Base_Path.
14. IF `ingress.enabled` equals `true` AND `ingress.hosts` holds zero entries, THEN THE Helm_Chart SHALL fail rendering with a message naming `ingress.hosts` and stating that an enabled ingress requires at least one host entry.

---

### Requirement 9: Base Path and Ingress Path Consistency

**User Story:** As an operator, I want the chart to catch a mismatch between the ingress path and the application base path, so that I avoid an installation that serves a blank page with failing asset requests.

#### Acceptance Criteria

1. WHERE `ingress.enabled` equals `true` AND `config.preservePath` equals `true`, THE Helm_Chart SHALL compare `config.basePath` against the `path` value of every entry in `ingress.hosts[*].paths` by exact string equality, after removing one trailing `/` character from an ingress `path` value whose length exceeds one character, and SHALL treat the configuration as consistent only when every compared pair is equal.
2. IF the comparison in criterion 9.1 finds at least one ingress `path` value differing from `config.basePath`, THEN THE Helm_Chart SHALL fail rendering with a non-zero exit status and SHALL name, in the failure message, `config.basePath`, the first mismatched ingress `path` value, and the zero-based index of the `ingress.hosts` entry containing that value.
3. WHERE `ingress.enabled` equals `true` AND `config.preservePath` equals `true` AND `config.basePath` equals an empty string, THE Helm_Chart SHALL treat an ingress `path` value of `/` as equal to `config.basePath` and SHALL complete rendering with a zero exit status.
4. WHERE `ingress.enabled` equals `true`, THE Notes_Template SHALL display exactly one resolved application URL composed of the scheme, the `host` value of `ingress.hosts[0]`, and `config.basePath`, SHALL set the scheme to `https` when `ingress.tls` contains at least one entry and to `http` otherwise, and SHALL append no trailing `/` when `config.basePath` equals an empty string.
5. WHERE `ingress.enabled` equals `false`, THE Notes_Template SHALL display exactly one `kubectl port-forward` command naming the release namespace, the Service rendered by Service_Template, a local port of `8080`, and the port number held in `service.port`.
6. IF rendering fails because of the comparison in criterion 9.1, THEN THE Helm_Chart SHALL emit zero Kubernetes resource manifests and SHALL leave an already-installed release at its pre-operation state.
7. IF `ingress.enabled` equals `true` AND an entry in `ingress.hosts` holds an absent or empty `paths` list, THEN THE Helm_Chart SHALL fail rendering with a non-zero exit status and a message naming `ingress.hosts` and the zero-based index of the entry holding no path.
8. WHERE `ingress.enabled` equals `true` AND the `host` value of `ingress.hosts[0]` equals an empty string, THE Notes_Template SHALL display a host placeholder in place of the host segment of the resolved application URL and SHALL state that the rendered rule matches every incoming host.

---

### Requirement 10: Replica Count and Single-Instance Session State

**User Story:** As an operator, I want the chart to reflect that session state lives in one process, so that I avoid scaling the deployment into a broken state.

#### Acceptance Criteria

1. THE Values_File SHALL set the default value of `replicaCount` to the integer `1`.
2. THE Values_Schema SHALL constrain `replicaCount` to type integer with a minimum value of 1, and SHALL treat `replicaCount` as a required key whose absence is a validation failure.
3. IF the resolved value of `replicaCount` is greater than 1 AND `service.sessionAffinity` differs from `ClientIP`, THEN THE Notes_Template SHALL render a warning in the post-install and post-upgrade output stating that poker and retro session state lives in each pod's memory and that all participants of one session require placement on a single pod.
4. THE Chart_Readme SHALL document, in the section that describes `replicaCount`, that the application holds session state in process memory, that the only supported value of `replicaCount` is 1, and that horizontal scaling requires shared external state not present in the current application.
5. THE Values_File SHALL include a comment on the line or lines immediately preceding the `replicaCount` key stating that the supported value is `1`.
6. THE Values_File SHALL set the default value of `autoscaling.enabled` to `false`.
7. IF `autoscaling.enabled` resolves to `true`, THEN THE Helm_Chart SHALL fail rendering before any Kubernetes resource is created or modified, SHALL emit an error message naming `autoscaling.enabled` and stating that the application requires a single replica, and SHALL leave any existing release revision unchanged.
8. IF the resolved value of `replicaCount` is absent, is not an integer, or is less than 1, THEN THE Helm_Chart SHALL fail rendering before any Kubernetes resource is created or modified, SHALL emit an error message naming `replicaCount` and the minimum value of 1, and SHALL leave any existing release revision unchanged.

---

### Requirement 11: Values Schema Validation

**User Story:** As an operator, I want my values validated before resources reach the cluster, so that a typo surfaces as a clear error at install time.

#### Acceptance Criteria

1. THE Values_Schema SHALL parse as a single valid JSON document that declares `$schema` as `https://json-schema.org/draft-07/schema#`, declares `type` as `object`, and accepts every default value declared in the Values_File without reporting a validation error.
2. THE Values_Schema SHALL list exactly the four property names `image`, `service`, `config`, and `replicaCount` in its top-level `required` array.
3. THE Values_Schema SHALL constrain `image.pullPolicy` to the string type with an enumerated set containing exactly the three values `Always`, `IfNotPresent`, and `Never`.
4. THE Values_Schema SHALL constrain `service.type` to the string type with an enumerated set containing exactly the three values `ClusterIP`, `NodePort`, and `LoadBalancer`.
5. THE Values_Schema SHALL constrain `service.port` and `service.targetPort` to the integer type with a minimum value of 1 and a maximum value of 65535 inclusive, and SHALL constrain `service.nodePort` to the JSON type set holding integer and null, applying a minimum value of 30000 and a maximum value of 32767 inclusive while the value holds the integer type, so that the Values_File default of `null` passes validation.
6. THE Values_Schema SHALL constrain `image.repository` to the string type with a minimum length of 1 character and a maximum length of 253 characters.
7. WHEN an Operator invokes `helm install`, `helm upgrade`, `helm template`, or `helm lint` on the Helm_Chart supplying a value whose JSON type conflicts with the Values_Schema, THE Helm_Chart SHALL reject the invocation with a non-zero exit status and an error message naming the conflicting property path and the type the Values_Schema expects.
8. THE Values_Schema SHALL set `additionalProperties` to `true` for `extraEnv`, `podAnnotations`, `ingress.annotations`, `nodeSelector`, and `affinity` so that an Operator supplies an unbounded number of cluster-specific entries under each of those keys.
9. IF an Operator invokes the Helm_Chart with any of the properties named in criterion 11.2 absent from the merged values, THEN THE Helm_Chart SHALL reject the invocation with a non-zero exit status and an error message naming each absent required property path.
10. IF an Operator supplies a value that falls outside an enumerated set or outside a numeric bound declared in the Values_Schema, THEN THE Helm_Chart SHALL reject the invocation with a non-zero exit status and an error message naming the offending property path together with the permitted values or the permitted minimum and maximum.
11. IF the Values_Schema rejects any supplied value during `helm install` or `helm upgrade`, THEN THE Helm_Chart SHALL create or modify zero cluster resources and SHALL leave an existing release at the revision in effect before the invocation.

---

### Requirement 12: Chart Validation and Smoke Tests

**User Story:** As a developer, I want automated validation of the chart, so that a template error or invalid manifest is caught before release.

#### Acceptance Criteria

1. THE Helm_Smoke_Test SHALL reside at the repository-relative path `tests/helm-smoke.test.sh`.
2. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL complete every check using only the local Helm_Chart sources, SHALL open no connection to a Kubernetes API server, and SHALL finish every check within 120 seconds.
3. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL execute Chart_Linter against the Helm_Chart with default values and SHALL record the check as failed when Chart_Linter exits with a status code other than 0.
4. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL execute Template_Renderer against the Helm_Chart with default values, SHALL pass the rendered output to Manifest_Validator, and SHALL record the check as failed when either Template_Renderer or Manifest_Validator exits with a status code other than 0.
5. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that the output of Template_Renderer with default values contains exactly one resource of kind Deployment and exactly one resource of kind Service.
6. WHERE `readinessProbe.enabled` equals `true` AND `livenessProbe.enabled` equals `true`, WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that the output of Template_Renderer with default values contains exactly two occurrences of the path `/api/health`, one under the readiness probe of Scrum_Poker_Container and one under the liveness probe of Scrum_Poker_Container.
7. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that the output of Template_Renderer with default values contains, for Scrum_Poker_Container, `resources.requests` entries with CPU `100m` and memory `128Mi` and `resources.limits` entries with CPU `500m` and memory `512Mi`.
8. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that Template_Renderer invoked with `ingress.enabled=false` exits with status code 0 and produces output containing zero resources of kind Ingress.
9. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that Template_Renderer invoked with `ingress.enabled=true` exits with status code 0 and produces output containing exactly one resource of kind Ingress carrying the annotation `nginx.ingress.kubernetes.io/proxy-read-timeout` with the value `3600`.
10. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that Template_Renderer invoked with `config.basePath=scrum-poker` exits with a status code other than 0 and emits a message naming `config.basePath`, confirming the leading-slash guard from Requirement 4.
11. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that Template_Renderer invoked with `config.preservePath=true`, `ingress.enabled=true`, and `config.basePath` set to a value differing from the configured ingress path exits with a status code other than 0 and emits a message naming `config.basePath`, confirming the consistency guard from Requirement 9.
12. WHEN the Helm_Smoke_Test completes an individual check, THE Helm_Smoke_Test SHALL print one line that names that check and states either pass, fail, or skipped.
13. IF the `helm` executable is absent on the host, THEN THE Helm_Smoke_Test SHALL print a message naming the missing `helm` executable before executing any check and SHALL exit with status code 1.
14. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL invoke Template_Renderer with a Release_Name of at least 40 characters composed of lowercase alphanumeric and hyphen characters and SHALL verify that every rendered resource name holds at most 63 characters and ends with a character other than a hyphen, confirming the truncation rule from Requirement 1.
15. WHEN the Helm_Smoke_Test runs, THE Helm_Smoke_Test SHALL verify that the Chart_Readme exists and that its values table holds one row for every top-level key declared in the Values_File, and SHALL report a failure line naming the missing file or the undocumented key when that check does not hold.
16. WHEN the Helm_Smoke_Test has completed every check, THE Helm_Smoke_Test SHALL print the total count of passed checks, the total count of failed checks, and the total count of skipped checks.
17. IF the failed count equals zero after every check has completed, THEN THE Helm_Smoke_Test SHALL exit with status code 0, and IF the failed count exceeds zero, THEN THE Helm_Smoke_Test SHALL exit with status code 1.
18. IF the `kubectl` executable is absent on the host, THEN THE Helm_Smoke_Test SHALL print a message naming the missing `kubectl` executable, SHALL record every Manifest_Validator check as skipped rather than failed, and SHALL execute the remaining Chart_Linter and Template_Renderer checks.

---

### Requirement 13: Operator Documentation

**User Story:** As an operator, I want installation and configuration documentation shipped with the chart, so that I install the application without reading the templates.

#### Acceptance Criteria

1. THE Chart_Readme SHALL reside at the repository-relative path `helm/scrum-poker/README.md`.
2. THE Chart_Readme SHALL state the minimum supported Helm version as `3.8` and the minimum supported Kubernetes version as `1.19`.
3. THE Chart_Readme SHALL include a `helm install` command that names a Release_Name placeholder and the local chart directory `helm/scrum-poker` as the chart source, requiring no edit other than substituting the Release_Name and namespace.
4. THE Chart_Readme SHALL include one `helm upgrade` command, one `helm uninstall` command, and one `helm lint` command, each naming the same Release_Name placeholder as criterion 13.3 and, for `upgrade` and `lint`, the local chart directory `helm/scrum-poker`.
5. THE Chart_Readme SHALL include a table with the columns name, description, and default value, holding one row for every configurable key declared in the Values_File including nested keys, with each name written in dot notation, each description holding between 10 and 200 characters, and each default value reproducing the Values_File default verbatim where an empty string renders as `""` and an empty mapping renders as `{}`.
6. THE Chart_Readme SHALL include a root-path installation example holding the `helm install` command with `config.basePath` set to an empty string, the matching `ingress.hosts[0].paths[0].path` value of `/`, and the resulting application URL.
7. THE Chart_Readme SHALL include a sub-path installation example holding the `helm install` command with `config.basePath` set to `/scrum-poker`, `config.preservePath` set to `true`, the matching `ingress.hosts[0].paths[0].path` value of `/scrum-poker`, and the resulting application URL.
8. THE Chart_Readme SHALL include a section naming each annotation in Websocket_Annotations, its chart default value, and the observable effect of that annotation on poker and retro real-time updates, including that a proxy read or send timeout shorter than the connection idle period closes the WebSocket connection.
9. THE Chart_Readme SHALL include a section stating that `auth.jwtSecret` supplies Jwt_Secret through a chart-rendered Secret, that a non-empty `auth.existingSecret` takes precedence and causes the chart to render no Secret, that `auth.existingSecretKey` defaults to `JWT_SECRET`, that an empty value for both inputs triggers random generation at install time, and the command an Operator runs to read the generated value from the cluster.
10. THE Values_File SHALL include, above every top-level key, at least one comment line of at least 10 characters stating the purpose of that key, and SHALL state the permitted values in that comment for every key the Values_Schema constrains to an enumerated set.
11. THE Chart_Readme SHALL state that the raw manifests under `k8s/` remain available and that the Helm_Chart with default values reproduces the same topology, naming one replica, `BASE_PATH=/scrum-poker`, `PRESERVE_PATH=true`, and the nginx ingress path `/scrum-poker`.
12. THE Chart_Readme SHALL include a troubleshooting entry for a blank page with failing asset requests that names a mismatch between `config.basePath` and the configured ingress path, names `config.preservePath`, and states the corrective value change.
13. THE Chart_Readme SHALL hold one values-table row for every top-level key declared in the Values_File so that the documentation check executed by the Helm_Smoke_Test under criterion 12.15 reports a pass.
