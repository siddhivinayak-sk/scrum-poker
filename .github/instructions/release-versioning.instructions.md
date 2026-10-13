---
description: "Use when cutting a release, bumping the Helm chart, or editing anything that carries a version number. Defines the git tag as the single source of truth, lists every file that must be bumped with it, and explains why a missed bump publishes two different chart versions."
applyTo: "helm/scrum-poker/Chart.yaml,helm/scrum-poker/README.md,.github/workflows/**,README.md,tests/helm/**"
---
# Release Versioning

## Single Source of Truth

- The git tag `vX.Y.Z` defines the release. Nothing else does.
- `helm/scrum-poker/Chart.yaml` `version` **and** `appVersion` must both equal `X.Y.Z` — the same number as the tag, without the leading `v`.
- `version` stays **unquoted** (`version: 0.0.7`); `appVersion` stays **quoted** (`appVersion: "0.0.7"`). Helm reads an unquoted `appVersion` like `1.2` as a float and rejects the chart.
- Bump `Chart.yaml` **in the same commit that gets tagged** — never in a follow-up commit. The tag must point at a tree whose `Chart.yaml` already agrees with it.

## Why It Matters

- `helm/chart-releaser-action` publishes whatever version is in `Chart.yaml` and has **no** `--version` override. The GHCR push in `publish-oci` derives its version from the release event instead. A missed bump therefore publishes **two different versions to two destinations** from one release.
- The divergence hits `appVersion` too, not just `version`: on a release event `publish-oci` packages with `--app-version <tag>` while chart-releaser takes `Chart.yaml`'s `appVersion` verbatim. `helm/scrum-poker/values.yaml` defaults `image.tag: ""` and `helm/scrum-poker/templates/deployment.yaml` falls back to `.Chart.AppVersion` when the tag is empty, so a stale `appVersion` ships the **wrong Docker image** to every operator who does not override `image.tag`. One release therefore publishes **two different container images** as well as two different chart versions — a missed bump is a wrong image, not merely a mislabelled chart.
- `skip_existing: true` means the Pages side fails *silently*: chart-releaser cuts a release only for a version that does not have one yet, so an un-bumped `Chart.yaml` is a quiet no-op, not a red build.
- The Docker image is `siddhivinayaksk/scrum-pocker` (the `pocker` misspelling is deliberate and differs from the chart name `scrum-poker`). `build-and-push.yml` tags it with `type=semver,pattern={{version}}`, so tag `v0.0.7` produces image tag `0.0.7` — which is exactly what `appVersion: "0.0.7"` must point at.

## Release Checklist

Work in this order:

1. Bump `version` and `appVersion` in `helm/scrum-poker/Chart.yaml`.
2. Update `helm/scrum-poker/README.md` — the `Chart version` and `App version` rows of the metadata table, and the `--version` in the OCI install command.
3. Update `README.md` — every `--version` under `### Helm Chart`, the `--set image.tag=` and `tag: "..."` lines in the values example, and the `docker pull siddhivinayaksk/scrum-pocker:<tag>` example.
4. **Run** the `tests/helm/` suite — do not edit it. No assertion there needs a manual bump: the two tests that assert against the committed chart (`name-bounds.test.ts` *holds for the chart as committed, with its own metadata* and `image-reference.test.ts` *holds for the chart as committed, with its own repository and appVersion*) read `helm/scrum-poker/Chart.yaml` at runtime, so they follow the bump on their own. The `0.1.0` literals still in `name-bounds.test.ts` and `selector-labels.test.ts` are deliberate static fixtures feeding patched chart copies and pure helpers — leave them exactly as they are.
5. Run `helm lint helm/scrum-poker` and `bash tests/helm-smoke.test.sh`. Run `cd tests/helm && npm run test:helm` if the harness is installed.
6. Commit.
7. Tag `vX.Y.Z` and publish the GitHub release.

## Files That Carry a Version

| Path | Field | What it should hold |
|------|-------|---------------------|
| `helm/scrum-poker/Chart.yaml` | `version` | `X.Y.Z`, unquoted |
| `helm/scrum-poker/Chart.yaml` | `appVersion` | `"X.Y.Z"`, quoted |
| `helm/scrum-poker/README.md` | metadata table `Chart version` / `App version` rows | `` `X.Y.Z` `` |
| `helm/scrum-poker/README.md` | `--version` in the GHCR OCI install command | `X.Y.Z` |
| `README.md` | `--version` in the four `helm install` / `helm template` commands under `### Helm Chart` | `X.Y.Z` |
| `README.md` | `--set image.tag=` and `tag: "..."` in the `my-values.yaml` example | `X.Y.Z` |
| `README.md` | `docker pull siddhivinayaksk/scrum-pocker:<tag>` example | `X.Y.Z` |
| `tests/helm/*.test.ts` | — | nothing to edit; the committed-chart assertions read `Chart.yaml` at runtime, and the remaining `0.1.0` literals are static fixtures. Run the suite, never bump it |
| `.github/workflows/*.yml` | — | nothing to edit; both workflows derive the version at runtime |

`client/package.json` and `server/package.json` do **not** track the release line. Neither is published to npm and neither feeds the chart or the image tag. Leave them alone.

## Enforcement That Exists Today

`.github/workflows/helm-publish.yml` has a *Warn when a release tag disagrees with Chart.yaml* step that compares the release tag against `Chart.yaml` and emits `::warning::` on a mismatch. It **warns and does not block** — the job still succeeds and both destinations still publish, at different versions. The checklist above is the real safeguard; do not rely on CI to catch a missed bump.
