/**
 * Feature: helm-chart-deployment, Property 3: Rendering is well-formed,
 * deterministic, and faithfully checksummed - task 10.6.
 *
 * *For any* values document that satisfies `values.schema.json`, rendering
 * exits with status 0 and produces output that parses as a YAML stream;
 * rendering the same document twice with `auth.jwtSecret` set to a non-empty
 * value produces byte-identical output; and the `checksum/config` pod
 * annotation is equal between two renderings exactly when their rendered
 * ConfigMaps are byte-equal.
 *
 * **Validates: Requirements 1.12, 2.10**
 *
 * ### Why `auth.jwtSecret` is pinned
 *
 * `scrum-poker.jwtSecret` falls back to `randAlphaNum 32` whenever
 * `auth.jwtSecret` is empty and `lookup` finds no live Secret - which is always
 * the case offline. Two renders of the same document would then differ in the
 * Secret's `JWT_SECRET` value, and byte-identity would be false for a reason
 * that has nothing to do with determinism of the templates. So every render
 * here replaces the whole `auth` mapping with `{jwtSecret: <pinned>,
 * existingSecret: ""}`: replacing rather than merging keeps guard 9 satisfied
 * no matter which `auth` shape the generator produced, and an empty
 * `existingSecret` means the chart's own Secret is always rendered, which the
 * last clause needs.
 *
 * ### Why the ConfigMap is compared as raw bytes
 *
 * Requirement 2.10 is about the ConfigMap's *rendered content*, down to a
 * single character, so the comparison cannot run against the parsed tree: YAML
 * parsing erases quoting and key order, and two textually different ConfigMaps
 * can parse to the same object. Each `# Source:`-prefixed chunk is therefore
 * sliced out of the `helm template` stream and compared verbatim.
 *
 * That chunk is not literally the string the chart hashes - the chart hashes
 * `include (print $.Template.BasePath "/configmap.yaml") .`, and Helm prefixes
 * the stream chunk with a `# Source:` comment. The two are still equal or
 * unequal together: the comment line is a constant, and everything that varies
 * between renders (the ConfigMap's name, its labels, and all four `data`
 * values) sits in the middle of the document, where no leading or trailing
 * whitespace normalisation can hide or manufacture a difference.
 *
 * ### The two directions, and the Secret
 *
 * The `iff` is exercised both ways by the same generated pair: two independent
 * `validValuesArb` documents frequently differ in the ConfigMap's inputs
 * (`service.targetPort`, `config.nodeEnv`, `config.basePath`,
 * `config.preservePath`, and the name the ConfigMap is given), and frequently
 * differ only outside them. The fourth render closes the loop the design calls
 * out deliberately: changing only the Secret's content must leave the checksum
 * alone, otherwise every upgrade would roll the pod on a freshly generated JWT
 * value.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseAllDocuments } from 'yaml';
import { renderChart, type RenderResult } from './support/render-chart.js';
import { assertConfig, releaseNameArb, validValuesArb } from './support/generators.js';

/** `# Source:` paths Helm prints above each chunk of the stream. */
const CONFIGMAP_SOURCE = 'scrum-poker/templates/configmap.yaml';
const DEPLOYMENT_SOURCE = 'scrum-poker/templates/deployment.yaml';
const SECRET_SOURCE = 'scrum-poker/templates/secret.yaml';

/** The annotation Requirement 2.10 names. */
const CHECKSUM_KEY = 'checksum/config';

/** Kinds the chart renders for every values document reachable here. */
const ALWAYS_RENDERED_KINDS = ['ConfigMap', 'Deployment', 'Service', 'Secret'] as const;

/**
 * Two distinct pinned JWT values. Both are non-empty, so `randAlphaNum` never
 * runs, and they differ, so the Secret's rendered bytes differ between them.
 */
const PINNED_SECRET = 'pinned-jwt-secret-value';
const ALTERNATE_SECRET = 'pinned-jwt-secret-valuf';

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The values patch as rendered: the generated document with `auth` pinned. */
function pinAuth(values: Record<string, unknown>, jwtSecret: string): Record<string, unknown> {
  return { ...values, auth: { jwtSecret, existingSecret: '' } };
}

/**
 * The raw text of the chunk Helm rendered from `source`, byte for byte.
 *
 * Helm emits one `---` separated chunk per template, each prefixed with a
 * `# Source:` comment, so a chunk can be recovered from the stream without
 * re-serialising anything.
 */
function chunkFor(stdout: string, source: string, context: string): string {
  const matching = stdout
    .split(/^---\s*$/m)
    .filter((chunk) => chunk.includes(`# Source: ${source}`));
  expect(
    matching.length,
    `${context}: expected exactly one document sourced from ${source}\n--- output ---\n${stdout}`,
  ).toBe(1);
  return matching[0] as string;
}

/**
 * Requirement 1.12: status 0, and a stream in which every document parses.
 *
 * `renderChart` already raises on a parse error, but the check is repeated
 * explicitly here because well-formedness is half of what this property
 * asserts - a clause that only ever fails as a thrown harness error is a
 * clause that is easy to lose. The four always-rendered kinds are asserted too,
 * so a render that emitted nothing cannot satisfy the property vacuously.
 */
function renderWellFormed(
  values: Record<string, unknown>,
  releaseName: string,
  context: string,
): RenderResult {
  const result = renderChart(values, { releaseName });

  expect(result.status, `${context}: render failed\n${result.stderr}`).toBe(0);

  for (const document of parseAllDocuments(result.stdout)) {
    expect(
      document.errors.map((error) => error.message),
      `${context}: rendered manifest is not valid YAML\n--- output ---\n${result.stdout}`,
    ).toEqual([]);
  }

  const kinds = result.docs.map((doc) => (isMapping(doc) ? doc['kind'] : undefined));
  for (const kind of ALWAYS_RENDERED_KINDS) {
    expect(kinds, `${context}: no rendered ${kind}`).toContain(kind);
  }

  return result;
}

/**
 * The Deployment's `checksum/config` pod annotation.
 *
 * The value is taken from the raw bytes rather than from the parsed tree, for a
 * narrow but real reason: `sha256sum` renders an unquoted 64-character hex
 * scalar, and a hash that happened to be all digits - or to look like
 * `12345e678...` - would be resolved by a YAML parser as a number, turning a
 * passing assertion into a seed-dependent failure. The parsed tree is still
 * used to prove the annotation sits where Requirement 2.10 puts it, on the pod
 * template rather than on the Deployment itself.
 */
function checksumAnnotation(result: RenderResult, context: string): string {
  const deployments = result.docs.filter(
    (doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === 'Deployment',
  );
  expect(deployments.length, `${context}: expected exactly one rendered Deployment`).toBe(1);

  const spec = (deployments[0] as Record<string, unknown>)['spec'];
  const template = isMapping(spec) ? spec['template'] : undefined;
  const metadata = isMapping(template) ? template['metadata'] : undefined;
  const annotations = isMapping(metadata) ? metadata['annotations'] : undefined;
  expect(
    isMapping(annotations),
    `${context}: pod template carries no annotations mapping`,
  ).toBe(true);
  expect(
    Object.keys(annotations as Record<string, unknown>),
    `${context}: pod template is missing the ${CHECKSUM_KEY} annotation`,
  ).toContain(CHECKSUM_KEY);

  const chunk = chunkFor(result.stdout, DEPLOYMENT_SOURCE, context);
  const match = /^\s*checksum\/config:[ ]+(\S+)\s*$/m.exec(chunk);
  expect(match, `${context}: no ${CHECKSUM_KEY} line in the rendered Deployment\n${chunk}`)
    .not.toBeNull();

  const value = (match as RegExpExecArray)[1] as string;
  // sha256sum: 64 lowercase hex characters, nothing else.
  expect(value, `${context}: ${CHECKSUM_KEY} is not a sha256 digest`).toMatch(/^[0-9a-f]{64}$/);
  return value;
}

/** A values pair, written as an `fc.assert` example. */
type Example = [string, Record<string, unknown>, Record<string, unknown>];

/** Keeps guard 13 out of the way when an example moves `config.basePath`. */
const noIngress = { ingress: { enabled: false } };

/**
 * Minimal pairs, supplied as examples so the two directions of Requirement
 * 2.10 are pinned down by named cases and not only by the generator's luck.
 *
 * The first group changes exactly one thing the ConfigMap renders - one
 * character of `BASE_PATH`, the `PORT`, the `NODE_ENV`, the `PRESERVE_PATH`,
 * and the ConfigMap's own name - so each must change the checksum. The second
 * group changes things the ConfigMap does not render at all, so each must
 * leave the checksum alone.
 */
const examples: Example[] = [
  // Identical inputs.
  ['rel', {}, {}],
  // One character of BASE_PATH.
  [
    'rel',
    { ...noIngress, config: { basePath: '/a' } },
    { ...noIngress, config: { basePath: '/ab' } },
  ],
  // PORT, NODE_ENV, PRESERVE_PATH.
  ['rel', {}, { service: { targetPort: 3001 } }],
  ['rel', {}, { config: { nodeEnv: 'development' } }],
  ['rel', {}, { config: { preservePath: false }, ...noIngress }],
  // The ConfigMap's name, which the hash covers along with its data.
  ['rel', {}, { nameOverride: 'other' }],
  ['rel', {}, { fullnameOverride: 'other-name' }],
  // Outside the ConfigMap: the checksum must not move.
  ['rel', {}, { podAnnotations: { 'example.com/owner': 'platform' } }],
  ['rel', {}, { image: { tag: 'other' } }],
  ['rel', {}, { extraEnv: [{ name: 'EXTRA', value: 'x' }] }],
  ['rel', {}, { resources: {} }],
  ['rel', {}, { livenessProbe: { enabled: false } }],
  ['rel', {}, { serviceAccount: { create: false, name: 'preexisting' } }],
  // A release name long enough to force fullname truncation.
  ['a-'.repeat(20) + 'z', {}, { podAnnotations: { 'example.com/owner': 'platform' } }],
];

describe('Property 3: rendering is well-formed, deterministic, and faithfully checksummed', () => {
  it('exits 0 with parseable YAML, repeats byte for byte, and tracks the ConfigMap exactly', () => {
    fc.assert(
      fc.property(
        releaseNameArb,
        validValuesArb,
        validValuesArb,
        (releaseName, firstValues, secondValues) => {
          const context = `release ${releaseName}`;
          const first = pinAuth(firstValues, PINNED_SECRET);

          // Requirement 1.12, and the baseline every other clause compares to.
          const firstRender = renderWellFormed(first, releaseName, `${context}, first render`);
          const repeatRender = renderWellFormed(first, releaseName, `${context}, repeat render`);

          // Determinism: same document, same release, same bytes.
          expect(
            repeatRender.stdout,
            `${context}: repeating an identical render changed the output`,
          ).toBe(firstRender.stdout);

          const firstConfigMap = chunkFor(firstRender.stdout, CONFIGMAP_SOURCE, context);
          const firstChecksum = checksumAnnotation(firstRender, `${context}, first render`);

          // Requirement 2.10, both directions, against an independent document.
          const otherRender = renderWellFormed(
            pinAuth(secondValues, PINNED_SECRET),
            releaseName,
            `${context}, second document`,
          );
          const otherConfigMap = chunkFor(otherRender.stdout, CONFIGMAP_SOURCE, context);
          const otherChecksum = checksumAnnotation(otherRender, `${context}, second document`);

          if (otherConfigMap === firstConfigMap) {
            expect(
              otherChecksum,
              `${context}: identical ConfigMap content produced different checksums\n` +
                `--- ConfigMap ---\n${firstConfigMap}`,
            ).toBe(firstChecksum);
          } else {
            expect(
              otherChecksum,
              `${context}: differing ConfigMap content produced the same checksum\n` +
                `--- first ---\n${firstConfigMap}\n--- second ---\n${otherConfigMap}`,
            ).not.toBe(firstChecksum);
          }

          // The Secret is deliberately outside the hash: a different JWT value
          // leaves the ConfigMap, and so the checksum, untouched.
          const resecretedRender = renderWellFormed(
            pinAuth(firstValues, ALTERNATE_SECRET),
            releaseName,
            `${context}, alternate secret`,
          );
          expect(
            chunkFor(resecretedRender.stdout, SECRET_SOURCE, context),
            `${context}: the two pinned JWT values rendered the same Secret`,
          ).not.toBe(chunkFor(firstRender.stdout, SECRET_SOURCE, context));
          expect(
            chunkFor(resecretedRender.stdout, CONFIGMAP_SOURCE, context),
            `${context}: changing the JWT value changed the ConfigMap`,
          ).toBe(firstConfigMap);
          expect(
            checksumAnnotation(resecretedRender, `${context}, alternate secret`),
            `${context}: changing only the Secret moved the checksum`,
          ).toBe(firstChecksum);
        },
      ),
      { ...assertConfig, examples },
    );
  });
});
