# Scrum Poker Helm Chart

Deploys Scrum Poker — a real-time collaborative planning poker and sprint
retrospective tool — as a single-container workload on Kubernetes.

The chart renders one Deployment, one Service, one ConfigMap, one Secret, one
ServiceAccount and (by default) one Ingress. Defaults reproduce the topology of the
raw manifests under [`k8s/`](../../k8s) — see
[Relationship to the raw manifests](#relationship-to-the-raw-manifests-under-k8s).

| | |
|---|---|
| Chart name | `scrum-poker` |
| Chart version | `0.0.8` |
| App version | `0.0.8` |
| Default image | `siddhivinayaksk/scrum-pocker` |
| Chart repo (HTTP) | `https://siddhivinayak-sk.github.io/scrum-poker` |
| Chart repo (OCI) | `oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker` |

The chart version and the app version always move together: the git tag `vX.Y.Z` is
the single source of truth for a release and `Chart.yaml` carries the same `X.Y.Z` in
both `version` and `appVersion` in the tagged commit. `image.tag` defaults to empty and
falls back to `appVersion`, so a default install of chart `0.0.8` pulls
`siddhivinayaksk/scrum-pocker:0.0.8`. The Docker Hub repository name keeps the
`pocker` misspelling; the chart name does not.

## Requirements

| Requirement | Minimum version |
|---|---|
| Helm | `3.8` |
| Kubernetes | `1.19` |

Helm `3.8` or later is required: the chart relies on `values.schema.json` enforcement
and on the `merge`, `deepCopy` and `lookup` template functions, and `3.8` is also the
first release that can install from an OCI registry without an experimental flag.

Kubernetes `1.19` or later is required for the `networking.k8s.io/v1` Ingress API. The
constraint is declared as `kubeVersion: ">=1.19.0-0"` in `Chart.yaml`, so Helm refuses
to install against an older cluster rather than rendering an Ingress the API server
cannot accept.

The default Ingress targets the [ingress-nginx](https://kubernetes.github.io/ingress-nginx/)
controller (`ingress.className: nginx`). Set `ingress.enabled: false` to skip it, or
`ingress.className` to the IngressClass your cluster provides.

## Chart layout

```
helm/scrum-poker/
├── Chart.yaml              # chart metadata and the kubeVersion constraint
├── values.yaml             # every input, with its default and a comment
├── values.schema.json      # JSON Schema — rejects bad values before rendering
├── .helmignore             # files excluded from `helm package`
├── README.md               # this file
└── templates/
    ├── _helpers.tpl        # naming, labelling, JWT resolution, cross-field guards
    ├── configmap.yaml      # PORT, NODE_ENV, BASE_PATH, PRESERVE_PATH
    ├── secret.yaml         # JWT_SECRET (skipped when auth.existingSecret is set)
    ├── serviceaccount.yaml # created when serviceAccount.create is true
    ├── deployment.yaml     # the single application pod
    ├── service.yaml        # ClusterIP 80 → container port 3000
    ├── ingress.yaml        # rendered when ingress.enabled is true
    └── NOTES.txt           # post-install URL, port-forward and secret-read hints
```

Values are validated in two layers. `values.schema.json` checks types, ranges and
enumerations before any template runs. The `scrum-poker.validate` helper, included as
the first action of every template, then checks the cross-field rules a per-key schema
cannot express — for example that `config.basePath` agrees with the configured ingress
path. A rejected install fails with a message naming the offending values path and
writes no manifests.

## Usage

Every command below uses `my-release` as the release name and `scrum-poker` as the
namespace. Substituting those two names is the only edit needed. Drop
`--create-namespace` if the namespace already exists.

### Install from the GitHub Pages chart repo

The classic HTTP chart repository, served from the `gh-pages` branch of
[siddhivinayak-sk/scrum-poker](https://github.com/siddhivinayak-sk/scrum-poker) by
the `publish-pages` job in `.github/workflows/helm-publish.yml`:

```bash
helm repo add scrum-poker https://siddhivinayak-sk.github.io/scrum-poker
helm repo update
helm search repo scrum-poker --versions
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker \
  --create-namespace
```

`helm search repo` prints the versions the repository index currently advertises:

```
NAME                    CHART VERSION  APP VERSION  DESCRIPTION
scrum-poker/scrum-poker 0.0.8          0.0.8        Real-time collaborative planning poker and spri...
```

Add `--version 0.0.8` to `helm install` to pin a version instead of taking the newest
one the index lists.

Two things about this repository are worth knowing before you debug it:

- **The Pages URL redirects.** `https://siddhivinayak-sk.github.io/scrum-poker` answers
  with a `301` to the project's custom domain. Helm follows the redirect, so the URL
  above is the one to add. A hand-rolled `curl` needs `-L`:
  `curl -L https://siddhivinayak-sk.github.io/scrum-poker/index.yaml`.
- **The packages live on GitHub Releases.** The index's `urls` entries point at
  `https://github.com/siddhivinayak-sk/scrum-poker/releases/download/scrum-poker-<version>/scrum-poker-<version>.tgz`,
  so a client needs reachability to `github.com` as well as to the Pages host.

Remove the repository again with `helm repo remove scrum-poker`.

### Install from the OCI registry on GHCR

The `publish-oci` job pushes the packaged chart to `oci://ghcr.io/siddhivinayak-sk/charts`,
which makes the full chart reference `oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker`:

```bash
helm install my-release oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker \
  --version 0.0.8 \
  --namespace scrum-poker \
  --create-namespace
```

`--version` is not optional here. An OCI reference has no index to search, so Helm
needs the exact tag; `0.0.8` is the current chart version. Inspect a version before
installing it with
`helm show chart oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker --version 0.0.8`.

**GHCR packages are private until someone makes them public.** The chart package is
public today — an anonymous `helm show chart` against it succeeds — but a `403` or
`unauthorized` on pull means the package visibility was changed, or that your client
is sending stale credentials. Authenticate with a GitHub personal access token that
carries the `read:packages` scope:

```bash
echo "$GITHUB_TOKEN" | helm registry login ghcr.io --username <your-github-username> --password-stdin
```

`helm registry logout ghcr.io` clears the stored credential afterwards.

### Install from a local clone

The local-directory install stays valid and is the right choice when you are editing
the chart:

```bash
helm install my-release helm/scrum-poker \
  --namespace scrum-poker \
  --create-namespace
```

Run it from the repository root, since `helm/scrum-poker` is a chart directory rather
than a repository reference. The chart's post-install notes print the application URL,
or a `kubectl port-forward` command when the Ingress is disabled.

## Relationship to the raw manifests under `k8s/`

The raw manifests in [`k8s/`](../../k8s) — `k8s/k8s.yaml` and `k8s/ingress.yaml` —
remain available and supported. They are the simpler path when you want no templating
and no Helm release state.

The chart with default values reproduces the same topology:

| Topology | Raw manifests | Chart default |
|---|---|---|
| Replicas | `replicas: 1` | `replicaCount: 1` |
| Base path | `BASE_PATH=/scrum-poker` | `config.basePath: /scrum-poker` → `BASE_PATH=/scrum-poker` |
| Path preservation | `PRESERVE_PATH=true` | `config.preservePath: true` → `PRESERVE_PATH=true` |
| Ingress | nginx, path `/scrum-poker` | `ingress.className: nginx`, `ingress.hosts[0].paths[0].path: /scrum-poker` |
| Service | ClusterIP, port 80 → 3000 | `service.type: ClusterIP`, `service.port: 80`, `service.targetPort: 3000` |
| Resources | `100m`/`128Mi` requests, `500m`/`512Mi` limits | identical |
| Health probes | readiness and liveness on `/api/health` | identical, on `/api/health` |

The chart delivers `PORT`, `NODE_ENV`, `BASE_PATH` and `PRESERVE_PATH` through a
ConfigMap rather than inline `env` entries, and adds a `JWT_SECRET` the raw manifests
do not supply. The resulting container environment is otherwise the same.

## Configuration

Every configurable key is listed below with its default as declared in
[`values.yaml`](values.yaml). Names use dot notation, so each one can be passed
straight to `--set` or written as the matching nesting in a values file. An empty
string default is shown as `""`, an empty mapping as `{}` and an empty list as `[]`.

| Name | Description | Default |
|---|---|---|
| `replicaCount` | Number of application pods. The only supported value is `1`, because session state lives in one process. | `1` |
| `image.repository` | Container image repository for the Scrum Poker application, as published by `build-and-push.yml`. | `siddhivinayaksk/scrum-pocker` |
| `image.tag` | Image tag to deploy. An empty value falls back to the chart's `appVersion`. | `""` |
| `image.pullPolicy` | Image pull policy. Permitted values: `Always`, `IfNotPresent`, `Never`. | `Always` |
| `imagePullSecrets` | Secrets used to pull the image from a private registry. An empty list omits the field. | `[]` |
| `nameOverride` | Overrides the chart name used in resource names and labels. | `""` |
| `fullnameOverride` | Replaces the generated release-qualified resource name outright. | `""` |
| `serviceAccount.create` | Whether to create a ServiceAccount for the pod. | `true` |
| `serviceAccount.name` | Name of the ServiceAccount. Empty with `create: false` resolves to the namespace default. | `""` |
| `serviceAccount.annotations` | Extra annotations on the ServiceAccount, for example a cloud IAM role binding. | `{}` |
| `podAnnotations` | Extra annotations applied to the pod template, merged under the chart's own `checksum/config`. An empty mapping omits the field. | `{}` |
| `podSecurityContext` | Pod-level security context, such as `fsGroup`. An empty mapping omits the field. | `{}` |
| `securityContext.runAsNonRoot` | Requires the container to run as a non-root user. | `true` |
| `securityContext.runAsUser` | Numeric UID the container process runs as. | `1000` |
| `securityContext.allowPrivilegeEscalation` | Whether the container may gain more privileges than its parent process. | `false` |
| `securityContext.readOnlyRootFilesystem` | Mounts the root filesystem read-only and adds the writable `/tmp` volume described by `tmpVolume`. | `true` |
| `securityContext.capabilities.drop` | Linux capabilities dropped from the container. | `[ALL]` |
| `tmpVolume.sizeLimit` | Size limit of the writable scratch volume mounted at `/tmp`. Only consumed by `deployment.yaml`, and only while `securityContext.readOnlyRootFilesystem` is true. | `64Mi` |
| `service.type` | Service type. Permitted values: `ClusterIP`, `NodePort`, `LoadBalancer`. | `ClusterIP` |
| `service.port` | Port the Service exposes inside the cluster. Also the port the Ingress backend references. | `80` |
| `service.targetPort` | Container port traffic is forwarded to, also published as the `PORT` environment variable in the ConfigMap. | `3000` |
| `service.nodePort` | Node port for `service.type: NodePort`. Permitted range 30000-32767; `null` omits the field, and the value is ignored for any other service type. | `null` |
| `service.sessionAffinity` | Service session affinity. Permitted values: `ClientIP`, `None`, `""`. Anything other than `ClientIP` renders `None`. | `None` |
| `service.sessionAffinityTimeoutSeconds` | Lifetime of a `ClientIP` affinity entry, in seconds. Rendered only when affinity is `ClientIP`. | `10800` |
| `service.annotations` | Extra annotations on the Service, for example cloud load balancer settings. | `{}` |
| `deploymentStrategy.type` | Deployment update strategy. Permitted values: `Recreate`, `RollingUpdate`. `Recreate` keeps one session holder at a time. | `Recreate` |
| `ingress.enabled` | Whether to render an Ingress exposing the application and its WebSocket endpoints. | `true` |
| `ingress.className` | IngressClass that serves the rule, matching the controller installed in the cluster. An empty value omits the field and the cluster default applies. | `nginx` |
| `ingress.annotations."nginx.ingress.kubernetes.io/proxy-read-timeout"` | Seconds the proxy waits for data from the application before closing a connection, including WebSockets. | `"3600"` |
| `ingress.annotations."nginx.ingress.kubernetes.io/proxy-send-timeout"` | Seconds the proxy waits while sending data to the application before closing a connection. | `"3600"` |
| `ingress.hosts[0].host` | Hostname the rule matches. An empty value serves the path on any host. | `""` |
| `ingress.hosts[0].paths[0].path` | URL path routed to the application. Must agree with `config.basePath` when `config.preservePath` is true. | `/scrum-poker` |
| `ingress.hosts[0].paths[0].pathType` | Path match mode. Permitted values: `Prefix`, `Exact`, `ImplementationSpecific`. | `Prefix` |
| `ingress.tls` | TLS blocks for the Ingress, each naming hosts and a certificate Secret. An empty list serves plain HTTP. | `[]` |
| `ingress.websocket.affinity` | Adds the computed `nginx.ingress.kubernetes.io/affinity: cookie` and `session-cookie-name` annotations, pinning a client to one pod. | `false` |
| `ingress.websocket.cookieName` | Cookie name used when `ingress.websocket.affinity` is enabled. Empty falls back to the release's full name. | `scrum-poker-affinity` |
| `config.nodeEnv` | Application run mode, published as `NODE_ENV`. Permitted values: `production`, `development`. | `production` |
| `config.basePath` | Public URL prefix, published as `BASE_PATH`. Empty means the cluster root. Needs a leading `/` and no trailing `/`. | `/scrum-poker` |
| `config.preservePath` | Set true when the ingress forwards the full path including `config.basePath`. Published as `PRESERVE_PATH`. False makes the chart add `nginx.ingress.kubernetes.io/rewrite-target: /`. | `true` |
| `auth.jwtSecret` | JWT signing key delivered through a chart-rendered Secret. Empty generates a 32-character random value at install time. | `""` |
| `auth.existingSecret` | Name of a pre-existing Secret holding the JWT key. Mutually exclusive with `auth.jwtSecret`, and renders no Secret. | `""` |
| `auth.existingSecretKey` | Key inside `auth.existingSecret` that holds the JWT signing value. | `JWT_SECRET` |
| `extraEnv` | Additional container environment variables, appended after the ConfigMap's `envFrom`, so an entry can override a ConfigMap key. Each entry needs a non-empty `name`. | `[]` |
| `resources.requests.cpu` | CPU the pod requests from the scheduler. | `100m` |
| `resources.requests.memory` | Memory the pod requests from the scheduler. | `128Mi` |
| `resources.limits.cpu` | CPU ceiling for the container; exceeding it throttles the process. | `500m` |
| `resources.limits.memory` | Memory ceiling for the container; exceeding it terminates the container. | `512Mi` |
| `readinessProbe.enabled` | Whether to render a readiness probe against `/api/health`. | `true` |
| `readinessProbe.initialDelaySeconds` | Seconds after container start before the first readiness check. | `5` |
| `readinessProbe.periodSeconds` | Interval in seconds between readiness checks. | `10` |
| `readinessProbe.timeoutSeconds` | Seconds a readiness check may take before it counts as failed. | `3` |
| `readinessProbe.successThreshold` | Consecutive successes needed to mark the container ready again. | `1` |
| `readinessProbe.failureThreshold` | Consecutive failures before the pod is removed from Service endpoints. | `3` |
| `livenessProbe.enabled` | Whether to render a liveness probe against `/api/health`. | `true` |
| `livenessProbe.initialDelaySeconds` | Seconds after container start before the first liveness check. | `10` |
| `livenessProbe.periodSeconds` | Interval in seconds between liveness checks. | `15` |
| `livenessProbe.timeoutSeconds` | Seconds a liveness check may take before it counts as failed. | `3` |
| `livenessProbe.successThreshold` | Consecutive successes needed to consider the container live. Must be `1`. | `1` |
| `livenessProbe.failureThreshold` | Consecutive failures before the container is restarted, clearing in-memory sessions. | `3` |
| `nodeSelector` | Node labels required for scheduling. An empty mapping omits the field. | `{}` |
| `tolerations` | Taints the pod tolerates. An empty list omits the field. | `[]` |
| `affinity` | Affinity and anti-affinity scheduling rules. An empty mapping omits the field. | `{}` |
| `autoscaling.enabled` | Horizontal autoscaling switch. Must stay `false`: the application supports exactly one replica, and `true` fails the render. | `false` |

Both probes target `/api/health` as a template literal, not a value. The application
registers that route on its root app before mounting everything else under
`BASE_PATH`, so the health endpoint answers at `/api/health` for every
`config.basePath` and there is nothing to configure.

## Configuration recipes

`config.basePath` and the configured ingress path are two halves of one decision and
the chart refuses to render them apart. While `config.preservePath` is `true`, the
ingress hands the application the full request path, so `config.basePath` must equal
`ingress.hosts[0].paths[0].path` exactly. Both path examples below therefore set both
keys.

A `--set` that addresses a list index replaces the whole list, so
`ingress.hosts[0].paths[0].path` discards the default `paths` entry. `pathType` is
left out on purpose: the template falls back to `Prefix` when the entry omits it, and
that is the default either way. In `zsh`, quote each `--set` argument — unquoted
square brackets are glob characters.

### Pinning an image tag

`image.tag` is empty by default and falls back to `appVersion`, which for chart
`0.0.8` means `siddhivinayaksk/scrum-pocker:0.0.8`. Pin it explicitly to deploy a
different build — `build-and-push.yml` publishes `X.Y.Z`, `X.Y` and `latest`:

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker --create-namespace \
  --set image.tag=0.0.8
```

```yaml
image:
  repository: siddhivinayaksk/scrum-pocker
  tag: "0.0.8"
  pullPolicy: IfNotPresent
```

`pullPolicy` defaults to `Always`, which is what you want for a floating tag such as
`latest`; `IfNotPresent` is the cheaper choice for an immutable version tag.

### Enabling the ingress with a hostname

The ingress is already enabled; what the default lacks is a host, so the rendered rule
matches every incoming host. Pin it:

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker --create-namespace \
  --set ingress.hosts[0].host=poker.example.com \
  --set ingress.hosts[0].paths[0].path=/scrum-poker
```

Add TLS and the application URL becomes `https`:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: poker.example.com
      paths:
        - path: /scrum-poker
          pathType: Prefix
  tls:
    - secretName: poker-tls
      hosts:
        - poker.example.com
```

Set `ingress.enabled: false` to render no Ingress at all and reach the Service through
`kubectl port-forward` or your own routing layer.

### Hosting under a sub-path

This is the chart default with a host added, and it matches `k8s/ingress.yaml`:

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker --create-namespace \
  --set config.basePath=/scrum-poker \
  --set config.preservePath=true \
  --set ingress.hosts[0].host=poker.example.com \
  --set ingress.hosts[0].paths[0].path=/scrum-poker
```

```yaml
config:
  basePath: /scrum-poker
  preservePath: true
ingress:
  hosts:
    - host: poker.example.com
      paths:
        - path: /scrum-poker
          pathType: Prefix
```

`config.basePath` becomes `BASE_PATH` in the ConfigMap, and the application prefixes
every asset URL and every WebSocket URL with it. `config.preservePath: true` says the
ingress forwards that prefix unchanged, so the chart adds no rewrite annotation.
Resulting URL:

```
http://poker.example.com/scrum-poker
```

Set `config.preservePath: false` instead when the ingress strips the prefix before
forwarding. The chart then adds `nginx.ingress.kubernetes.io/rewrite-target: /`, the
application mounts its routes at the root, and the basePath/ingress-path equality
check is switched off.

### Serving at the cluster root

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker --create-namespace \
  --set config.basePath="" \
  --set ingress.hosts[0].host=poker.example.com \
  --set ingress.hosts[0].paths[0].path=/
```

`config.basePath=""` renders `BASE_PATH=""` in the ConfigMap, which makes the
application serve its routes and assets from the root. The empty value normalises to
`/` for the consistency check, which is why the ingress path has to be `/` and nothing
else. Resulting URL:

```
http://poker.example.com
```

No trailing separator: an empty base path appends nothing to the host.

### Setting the JWT secret

Leave `auth.jwtSecret` empty and the chart generates a 32-character random value at
install time. Supply your own when you need the signing key to be reproducible across
clusters — **never commit it to a values file that lives in version control.** Pass it
on the command line:

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker --create-namespace \
  --set auth.jwtSecret="$(openssl rand -base64 32)"
```

Or hand the chart a Secret you manage out of band, which is the better pattern for a
GitOps repository:

```bash
kubectl create secret generic my-jwt-secret \
  --namespace scrum-poker \
  --from-literal=JWT_SECRET="$(openssl rand -base64 32)"
```

```yaml
auth:
  existingSecret: my-jwt-secret
  existingSecretKey: JWT_SECRET
```

The two inputs are mutually exclusive and supplying both fails the render. See
[JWT secret](#jwt-secret) for the full precedence table.

### Resources

All four quantities are independent leaves. Raise or lower any of them:

```bash
helm upgrade my-release scrum-poker/scrum-poker \
  --namespace scrum-poker \
  --set resources.requests.memory=256Mi \
  --set resources.limits.memory=1Gi
```

```yaml
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: "1"
    memory: 1Gi
```

Null a leaf out to drop it and let the cluster's own defaults or LimitRange apply. The
template omits `resources` entirely when none of the four carries a value:

```yaml
resources:
  requests:
    cpu: null
    memory: null
  limits:
    cpu: null
    memory: null
```

### Replica count

`replicaCount` is `1` and `1` is the only supported value — the chart accepts a higher
number but the application cannot use it, because session state lives in one process.
See [Replica count and scaling](#replica-count-and-scaling) before changing it. There
is no autoscaling recipe: `autoscaling.enabled: true` fails the render by design, and
the key exists only to say so.

## WebSocket support

Poker and retro updates both travel over WebSocket connections that share the ingress
path with ordinary HTTP traffic. The poker client connects to `{basePath}` itself and
the retro client to `{basePath}/retro`, so the single rule the chart renders carries
all of it — no second Ingress and no separate path entry. The server splits the
upgrade by path internally: anything starting with `/retro` goes to the retro handler,
everything else to the poker handler.

ingress-nginx proxies a WebSocket upgrade without any annotation, so there is no
"enable websockets" switch to find. What an operator does have to get right is the
**idle timeout**, and with more than one pod, **affinity**.

| Annotation | Chart default | Effect on poker and retro updates |
|---|---|---|
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | `"3600"` | Seconds the proxy waits for a frame from the application before closing the connection. A connection closed here stops delivering vote reveals, timer ticks, participant joins and retro card edits to that client. |
| `nginx.ingress.kubernetes.io/proxy-send-timeout` | `"3600"` | Seconds the proxy waits while writing a frame to the application. A connection closed here stops the client's own votes, card edits and reveals from reaching the server. |
| `nginx.ingress.kubernetes.io/affinity` | not set; `cookie` when `ingress.websocket.affinity` is `true` | Pins a client to the pod it first reached, so its HTTP requests and its WebSocket connection land on the same in-memory session. |
| `nginx.ingress.kubernetes.io/session-cookie-name` | not set; `ingress.websocket.cookieName`, default `scrum-poker-affinity`, when affinity is `true` | Names the cookie that carries the pinning, so it does not collide with another application's affinity cookie on the same host. |

**A read or send timeout shorter than the period a connection sits idle closes that
connection.** nginx measures both timeouts between successive frames, not from the
start of the connection, so a planning session where nobody votes for a while is
exactly the case that trips a short timeout. The server pings every open connection
every 30 seconds and drops a participant after two unanswered pings, which means a
healthy connection is never idle for more than about 30 seconds — but a
`proxy-read-timeout` below that still cuts connections mid-session. The chart's
`"3600"` leaves an hour of headroom.

The closure is observable: the affected client stops receiving updates, reconnects
with exponential backoff, and other participants briefly see it leave and rejoin.

`ingress.annotations` is an open mapping, so any annotation your controller
understands can be added, and an operator entry always wins over a computed one —
including when its value is the empty string:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "7200"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "7200"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
  websocket:
    affinity: true
    cookieName: scrum-poker-affinity
```

The same override on the command line, with the dots in the annotation key escaped:

```bash
  --set ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-read-timeout"=7200
```

On a controller other than ingress-nginx the annotation names differ — Traefik,
HAProxy and the cloud load balancer controllers each have their own idle-timeout key —
but the requirement is the same: an idle timeout generous enough to outlast a quiet
planning session, and no buffering in front of the upgrade.

## JWT secret

The application signs its session tokens with `JWT_SECRET`. The container always
receives it through a `secretKeyRef`; which Secret that reference names depends on two
values.

| `auth.jwtSecret` | `auth.existingSecret` | What the chart does |
|---|---|---|
| empty | empty | Generates a 32-character random value at install time and stores it in a chart-rendered Secret. |
| non-empty | empty | Stores the supplied value in a chart-rendered Secret. |
| empty | non-empty | Renders **no** Secret and references the named one. |
| non-empty | non-empty | Rejected before rendering — the two are mutually exclusive. |

`auth.jwtSecret` supplies the key through a Secret the chart renders, named
`<release>-scrum-poker-secret`, holding the single base64-encoded key `JWT_SECRET`:

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker \
  --set auth.jwtSecret=$(openssl rand -base64 32)
```

A non-empty `auth.existingSecret` takes precedence and the chart renders no Secret at
all — not an empty document, no resource. The deployment's `secretKeyRef` points at
your Secret instead, and the chart never reads, copies or logs the value:

```bash
helm install my-release scrum-poker/scrum-poker \
  --namespace scrum-poker \
  --set auth.existingSecret=my-jwt-secret
```

`auth.existingSecretKey` names the key inside that Secret and defaults to
`JWT_SECRET`, so a Secret created with `--from-literal=JWT_SECRET=…` needs no further
configuration. Set it when your Secret uses a different key:

```bash
  --set auth.existingSecret=my-jwt-secret \
  --set auth.existingSecretKey=token
```

Supplying both `auth.jwtSecret` and `auth.existingSecret` fails before any resource is
written, with a message naming both keys.

### Reading the generated value

When both inputs are empty the chart generates the value, so it exists only in the
cluster. Read it back with:

```bash
kubectl get secret my-release-scrum-poker-secret \
  --namespace scrum-poker \
  -o jsonpath='{.data.JWT_SECRET}' | base64 -d
```

The post-install notes print this same command whenever `auth.existingSecret` is empty.

A generated value survives `helm upgrade`: the chart looks the stored value up and
reuses it, so issued tokens stay valid and nobody is logged out. Two consequences
follow. `helm uninstall` deletes the Secret, and a fresh install generates a new value
that invalidates every existing token. And the generated value is only reused against
a live cluster — `helm template` and `helm lint` cannot look anything up, so each
offline render prints a different random value. That is expected and changes nothing
about an installed release.

## Replica count and scaling

`replicaCount` defaults to `1` and **`1` is the only supported value.**

Poker and retro session state — participants, the current voting round, card
selections, reveal state, retro columns and cards — lives in the memory of a single
Node.js process. Nothing is persisted and nothing is shared between processes. A
second pod would hold a second, disconnected set of sessions: two participants who
joined the same session ID would see different votes and different retro boards,
depending on which pod their connection reached.

Horizontal scaling therefore needs shared external state the application does not
have. Making `replicaCount` greater than `1` work would mean moving session state out
of process memory into a shared store and broadcasting WebSocket events across pods —
a change to the application, not to this chart.

Two related guards fall out of that:

- `autoscaling.enabled` must stay `false`. Setting it to `true` fails rendering with a
  message naming `autoscaling.enabled`, before any resource is created or modified.
- `replicaCount` must be an integer of at least `1`. The chart does not block a value
  above `1` — an operator who deliberately accepts split sessions can still set it —
  but the post-install notes print a warning whenever `replicaCount` exceeds `1`
  without `service.sessionAffinity: ClientIP`.

`service.sessionAffinity: ClientIP` and `ingress.websocket.affinity: true` pin one
client to one pod. That keeps a single client consistent with itself; it does not make
two clients in the same session land on the same pod, so it is a mitigation and not a
fix.

The default `deploymentStrategy.type` is `Recreate` for the same reason: the old pod
stops before the new one starts, so two pods never hold sessions at once. Every
in-memory session is lost at that point, which is also what a liveness-probe restart
does.

## Verify the install

Helm prints the release status and the resolved application URL on install. Re-read
them any time with:

```bash
helm status my-release --namespace scrum-poker
```

The pod should reach `1/1 Running` within a few seconds of the image being pulled —
the readiness probe starts checking after 5 seconds and passes once the Node.js
process answers on `/api/health`:

```bash
kubectl get pods --namespace scrum-poker -l app.kubernetes.io/instance=my-release
kubectl get svc,ingress --namespace scrum-poker -l app.kubernetes.io/instance=my-release
```

Reach the application without going through the ingress by forwarding a local port to
the Service's port `80`:

```bash
kubectl port-forward --namespace scrum-poker svc/my-release-scrum-poker 8080:80
```

Then check health. `/api/health` is served at that fixed path regardless of
`config.basePath`, so this URL is the same for a root install and a sub-path install:

```bash
curl -i http://localhost:8080/api/health
```

The UI itself does honour the base path, so with the default
`config.basePath: /scrum-poker` the application loads at
`http://localhost:8080/scrum-poker` while port-forwarding.

If the pod is not ready, the probe target is the first thing to check:

```bash
kubectl logs --namespace scrum-poker -l app.kubernetes.io/instance=my-release --tail=50
kubectl describe pod --namespace scrum-poker -l app.kubernetes.io/instance=my-release
```

## Upgrade and uninstall

An upgrade from the HTTP repository — run `helm repo update` first, or Helm resolves
against a stale cached index:

```bash
helm repo update
helm upgrade my-release scrum-poker/scrum-poker \
  --namespace scrum-poker \
  --version 0.0.8
```

From the OCI registry:

```bash
helm upgrade my-release oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker \
  --namespace scrum-poker \
  --version 0.0.8
```

From a local clone:

```bash
helm upgrade my-release helm/scrum-poker \
  --namespace scrum-poker
```

An upgrade with unchanged values preserves a generated `JWT_SECRET`, so existing
sessions and tokens survive. The default `deploymentStrategy.type` is `Recreate`: the
old pod terminates before the new one starts, which briefly interrupts service and
clears in-memory session state. A config change rolls the pod on its own — the pod
template carries a `checksum/config` annotation over the ConfigMap.

Roll back a bad upgrade with `helm rollback my-release --namespace scrum-poker`.

### Uninstall

```bash
helm uninstall my-release --namespace scrum-poker
```

That deletes every resource the chart created: the Deployment, Service, ConfigMap,
ServiceAccount, Ingress and the rendered Secret. The chart creates no PersistentVolume
or PersistentVolumeClaim, so no storage is left behind — the only volume is an
`emptyDir` for `/tmp`, which dies with the pod.

Three things are **not** cleaned up:

- **The namespace.** `--create-namespace` creates it, `helm uninstall` does not remove
  it. Drop it yourself with `kubectl delete namespace scrum-poker` once nothing else
  lives there.
- **A Secret named by `auth.existingSecret`.** The chart never owned it, so it stays.
- **The chart repository entry.** `helm repo remove scrum-poker` if you added it.

And one consequence rather than a leftover: uninstalling deletes the rendered Secret,
so a later reinstall generates a new `JWT_SECRET` and every previously issued token
stops verifying. Pin `auth.jwtSecret`, or use `auth.existingSecret`, if that matters.

## Lint and render offline

```bash
helm lint helm/scrum-poker
```

`helm lint` takes a chart directory and no release name — it renders with a fixed
internal release name. To validate the chart under the release name you actually
intend to use, render it explicitly instead:

```bash
helm template my-release helm/scrum-poker \
  --namespace scrum-poker
```

Both commands are offline: neither contacts an API server, so both work before the
namespace exists. Add `--set key=value` or `-f my-values.yaml` to either to check a
non-default configuration, including that the cross-field guards accept it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `helm install` reports the chart version is not found right after a release | The local repository index is a cached copy from before the release. | `helm repo update`, then `helm search repo scrum-poker --versions`. [Details below.](#a-new-chart-version-is-not-found) |
| `403` or `unauthorized` pulling `oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker` | The GHCR package is not public, or the client holds a stale or scope-less credential. | `helm registry login ghcr.io` with a token carrying `read:packages`. [Details below.](#403-pulling-from-ghcr) |
| Blank page; asset requests for JS and CSS return 404 | `config.basePath` does not match the configured ingress path, so the application prefixes its asset URLs with a path the ingress never routes — or `config.preservePath` misdescribes what the ingress forwards. | Set `config.basePath` equal to `ingress.hosts[0].paths[0].path`, and set `config.preservePath` to `true` for a path-preserving ingress or `false` for a path-stripping one. [Details below.](#blank-page-with-failing-asset-requests) |
| Install or upgrade fails naming `config.basePath` | The same mismatch, caught by the chart before anything reaches the cluster. | Set `config.basePath` equal to `ingress.hosts[0].paths[0].path`. |
| WebSocket connects, then updates stop arriving after a quiet period | A `proxy-read-timeout` or `proxy-send-timeout` shorter than the idle period between frames. | Raise both annotations; the chart default is `"3600"`. [Details below.](#websocket-disconnects) |
| Participants in one session see different votes or boards | `replicaCount` is greater than `1`. | Set `replicaCount: 1`. |
| Everyone logged out after an uninstall-and-reinstall cycle | A new `JWT_SECRET` was generated, invalidating existing tokens. | Pin the value with `auth.jwtSecret`, or supply `auth.existingSecret`. |
| Pod never becomes ready; `/api/health` fails | The probe path is fixed at `/api/health` and does not move with `config.basePath`, so a failure here is the application not starting, not a path problem. | Read `kubectl logs` for the pod; check the image tag exists. |

### A new chart version is not found

`helm install --version` and `helm search repo` both read the index Helm cached when
the repository was last updated, not the live one. A release published minutes ago is
invisible until you refresh:

```bash
helm repo update scrum-poker
helm search repo scrum-poker --versions
```

If the version is still missing, check what the repository itself advertises:

```bash
curl -L https://siddhivinayak-sk.github.io/scrum-poker/index.yaml
```

A version absent from that file was never published. The `publish-pages` job runs
chart-releaser with `skip_existing: true`, and chart-releaser publishes whatever
version `Chart.yaml` holds with no override — so a push that did not bump
`Chart.yaml` `version` is a silent no-op, not a failed build. The git tag `vX.Y.Z` and
`Chart.yaml` have to agree in the same commit. An OCI reference has no index at all,
so it has no staleness problem; `helm show chart oci://… --version X.Y.Z` either
resolves or does not.

### 403 pulling from GHCR

GHCR packages start out private. If the chart package's visibility is private, an
anonymous pull returns `403 Forbidden` or `unauthorized` with no hint that permission
is the cause. Log in with a GitHub personal access token that has `read:packages`:

```bash
echo "$GITHUB_TOKEN" | helm registry login ghcr.io --username <your-github-username> --password-stdin
helm pull oci://ghcr.io/siddhivinayak-sk/charts/scrum-poker --version 0.0.8
```

A stored credential that has expired produces the same error, so
`helm registry logout ghcr.io` followed by a fresh login is worth trying before
anything else. The HTTP repository needs no authentication and is the fallback.

### WebSocket disconnects

A session that loads fine and then goes quiet — votes stop appearing, participants
appear to leave and rejoin — is an idle timeout on the proxy, not an application
fault. Check what the Ingress actually carries:

```bash
kubectl get ingress my-release-scrum-poker --namespace scrum-poker -o yaml
```

Both `nginx.ingress.kubernetes.io/proxy-read-timeout` and `proxy-send-timeout` should
be present and comfortably above 30 seconds; the chart ships `"3600"`. If a cluster
default or another layer (a cloud load balancer in front of the controller, a service
mesh sidecar) imposes a shorter one, that layer needs raising too — the annotation
only configures ingress-nginx.

With `replicaCount` above `1`, a disconnect that recurs on reconnect is an affinity
problem instead: set `ingress.websocket.affinity: true` and
`service.sessionAffinity: ClientIP`, and read
[Replica count and scaling](#replica-count-and-scaling) for why that is a mitigation
rather than a fix.

### Blank page with failing asset requests

The application rewrites every asset URL in `index.html` to carry `BASE_PATH` as a
prefix. A browser loading the page at `/scrum-poker` therefore requests
`/scrum-poker/main-<hash>.js`. The page renders blank when that request does not reach
the application, and there are two ways to arrive there.

**The paths disagree.** `config.basePath` is `/scrum-poker` while the ingress routes
`/poker`, or the reverse. Assets are requested under one prefix and served under
another. While `config.preservePath` is `true` the chart catches this and refuses to
install:

```
config.basePath: "/other" does not match ingress.hosts[0].paths[0].path "/scrum-poker"
```

Correct it by making the two equal — set `config.basePath` to the ingress path, or set
the ingress path to `config.basePath`:

```bash
helm upgrade my-release helm/scrum-poker \
  --namespace scrum-poker \
  --set config.basePath=/scrum-poker \
  --set ingress.hosts[0].paths[0].path=/scrum-poker
```

**`config.preservePath` misdescribes the ingress.** The check above only runs while
`config.preservePath` is `true`, so a wrong value here reaches the cluster and shows up
as the blank page rather than as an install error. `config.preservePath` declares
whether the ingress forwards the full path:

- `true` — the ingress forwards `/scrum-poker/main.js` unchanged. The application
  mounts its routes under `/scrum-poker` and expects the prefix. This is the chart
  default, and the chart adds no `rewrite-target` annotation.
- `false` — the ingress strips the prefix and forwards `/main.js`. The chart sets
  `nginx.ingress.kubernetes.io/rewrite-target: /`, and the application mounts its
  routes at the root while still prefixing asset URLs with `BASE_PATH` so the browser
  keeps addressing them through the ingress.

A `true` setting against a stripping ingress means the application receives `/main.js`
while listening under `/scrum-poker`, and every asset 404s. A `false` setting against
a preserving ingress means it receives `/scrum-poker/main.js` while listening at the
root, with the same result. Set `config.preservePath` to match the controller's actual
behaviour:

```bash
helm upgrade my-release helm/scrum-poker \
  --namespace scrum-poker \
  --set config.preservePath=false
```

Confirm either fix without a cluster by rendering the ConfigMap and the Ingress
together and reading `BASE_PATH`, `PRESERVE_PATH` and the ingress `path` as one
picture:

```bash
helm template my-release helm/scrum-poker \
  --namespace scrum-poker \
  -s templates/configmap.yaml -s templates/ingress.yaml
```
