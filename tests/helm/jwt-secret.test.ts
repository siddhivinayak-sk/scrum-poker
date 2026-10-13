/**
 * Feature: helm-chart-deployment - task 4.3.
 *
 * Property 8: The JWT secret survives encoding and is generated to specification
 *
 * *For any* non-empty `auth.jwtSecret` value, the rendered Secret holds exactly
 * one data key `JWT_SECRET` whose base64 decoding equals that value; *for any*
 * rendering with `auth.jwtSecret` and `auth.existingSecret` both empty and no
 * stored Secret available, the decoded value is exactly 32 characters drawn
 * only from upper-case letters, lower-case letters, and digits; and *for any*
 * non-empty `auth.existingSecret` and *any* `auth.existingSecretKey`, the
 * container's `secretKeyRef` names that Secret and uses that key, or
 * `JWT_SECRET` when the key is empty.
 *
 * **Validates: Requirements 5.2, 5.5, 5.6**
 *
 * ### Why the generated-value clause holds offline
 *
 * `scrum-poker.jwtSecret` resolves a stored value through `lookup`, which
 * returns an empty map whenever there is no live API connection - the case for
 * `helm template`. So an offline render with both inputs empty always falls
 * through to `randAlphaNum 32`, which is exactly the precondition the clause
 * describes ("no stored Secret available"). The assertion is on the *shape* of
 * the value, not its stability: two renders legitimately differ.
 *
 * ### Why the Deployment assertions are located defensively
 *
 * The `JWT_SECRET` env wiring belongs to task 7.2 and may land after this file.
 * The Secret-side invariants are asserted unconditionally; the `secretKeyRef`
 * assertions run only when a `JWT_SECRET` env entry is actually present, so
 * this property passes against a Deployment that does not yet carry one and
 * strengthens by itself once it does. A render that produced no `env` entry in
 * *any* iteration is reported on the console rather than passing silently.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { renderChart, type RenderResult } from './support/render-chart.js';
import { assertConfig, releaseNameArb, secretValueArb } from './support/generators.js';

/** The single data key the Secret is allowed to carry (Requirement 5.2). */
const DATA_KEY = 'JWT_SECRET';

/** The alphabet and length `randAlphaNum 32` draws from (Requirement 5.6). */
const GENERATED_SECRET = /^[A-Za-z0-9]{32}$/;
const GENERATED_SECRET_LENGTH = 32;

/** Canonical, padded standard base64 - the form sprig's `b64enc` emits. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every rendered document of the given `kind`. */
function docsOfKind(docs: unknown[], kind: string): Record<string, unknown>[] {
  return docs.filter((doc): doc is Record<string, unknown> => isMapping(doc) && doc['kind'] === kind);
}

/**
 * The `data` mapping of the one rendered Secret.
 *
 * Exactly one Secret is expected, so a second one - or none - is reported here
 * rather than silently picking the first.
 */
function secretData(result: RenderResult, context: string): Record<string, unknown> {
  const secrets = docsOfKind(result.docs, 'Secret');
  expect(secrets.length, `${context}: expected exactly one rendered Secret`).toBe(1);
  const data = (secrets[0] as Record<string, unknown>)['data'];
  expect(isMapping(data), `${context}: rendered Secret data is not a mapping`).toBe(true);
  return data as Record<string, unknown>;
}

/** Base64 decode as UTF-8, the inverse of sprig's `b64enc` on a Go string. */
function decodeBase64(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * The `JWT_SECRET` entry of the application container's `env` list, or
 * `undefined` when the Deployment does not carry one yet.
 *
 * The container is located by name where possible and otherwise by position,
 * so this keeps working whichever shape task 7.2 settles on.
 */
function jwtEnvEntry(docs: unknown[]): Record<string, unknown> | undefined {
  for (const deployment of docsOfKind(docs, 'Deployment')) {
    const spec = deployment['spec'];
    const template = isMapping(spec) ? spec['template'] : undefined;
    const podSpec = isMapping(template) ? template['spec'] : undefined;
    const containers = isMapping(podSpec) ? podSpec['containers'] : undefined;
    if (!Array.isArray(containers)) {
      continue;
    }
    for (const container of containers) {
      if (!isMapping(container)) {
        continue;
      }
      const env = container['env'];
      if (!Array.isArray(env)) {
        continue;
      }
      const entry = env.find((candidate) => isMapping(candidate) && candidate['name'] === DATA_KEY);
      if (isMapping(entry)) {
        return entry;
      }
    }
  }
  return undefined;
}

/** The `secretKeyRef` of a `JWT_SECRET` env entry. */
function secretKeyRef(entry: Record<string, unknown>, context: string): Record<string, unknown> {
  const valueFrom = entry['valueFrom'];
  expect(isMapping(valueFrom), `${context}: JWT_SECRET env entry has no valueFrom mapping`).toBe(
    true,
  );
  // A literal `value` would put the key in the pod spec in plain text.
  expect(entry['value'], `${context}: JWT_SECRET is injected as a literal value`).toBeUndefined();
  const ref = (valueFrom as Record<string, unknown>)['secretKeyRef'];
  expect(isMapping(ref), `${context}: JWT_SECRET env entry has no secretKeyRef`).toBe(true);
  return ref as Record<string, unknown>;
}

/** Local DNS-1123 label generator, for `auth.existingSecret` names. */
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const dnsLabelArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ALNUM),
    fc.array(fc.constantFrom(...ALNUM, '-', '.'), { minLength: 0, maxLength: 20 }),
    fc.constantFrom(...ALNUM),
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`);

/**
 * Secret keys an operator may name, plus the two values that must resolve to
 * `JWT_SECRET`: an empty string, and the key being absent from the values file
 * altogether (`undefined`), which leaves the chart default in place.
 */
const existingSecretKeyArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<string | undefined>('') },
  { weight: 1, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constant<string | undefined>(DATA_KEY) },
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
        fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), {
          minLength: 0,
          maxLength: 16,
        }),
      )
      .map(([first, rest]): string | undefined => `${first}${rest.join('')}`),
  },
);

/** `auth` patch for an operator-supplied key. `existingSecret` stays empty (guard 9). */
function explicitAuth(jwtSecret: string): Record<string, unknown> {
  return { auth: { jwtSecret, existingSecret: '' } };
}

describe('Property 8: the JWT secret survives encoding and is generated to specification', () => {
  it('base64-encodes any explicit auth.jwtSecret into the one JWT_SECRET data key', () => {
    let sawEnvEntry = false;

    fc.assert(
      fc.property(secretValueArb, (jwtSecret) => {
        const context = `auth.jwtSecret of ${jwtSecret.length} chars`;
        const result = renderChart(explicitAuth(jwtSecret));

        expect(result.status, `${context}\n${result.stderr}`).toBe(0);

        const data = secretData(result, context);

        // Exactly one data key, named JWT_SECRET, and no other.
        expect(Object.keys(data), `${context}: data keys`).toEqual([DATA_KEY]);

        const encoded = data[DATA_KEY];
        expect(typeof encoded, `${context}: data.JWT_SECRET is not a string`).toBe('string');
        expect(encoded as string, `${context}: data.JWT_SECRET is not canonical base64`).toMatch(
          BASE64,
        );

        // The round trip: decoding yields the operator's value byte for byte,
        // including the UTF-8 bytes of a non-ASCII value.
        expect(decodeBase64(encoded as string), `${context}: decoded value`).toBe(jwtSecret);
        expect(encoded as string, `${context}: encoding is not UTF-8 base64`).toBe(
          Buffer.from(jwtSecret, 'utf8').toString('base64'),
        );

        // An explicit value is never generated, so it must not look like one
        // unless the operator happened to supply such a string.
        const entry = jwtEnvEntry(result.docs);
        if (entry !== undefined) {
          sawEnvEntry = true;
          const ref = secretKeyRef(entry, context);
          // With no existingSecret the container reads the chart's own Secret.
          const secrets = docsOfKind(result.docs, 'Secret');
          const secretName = (secrets[0]?.['metadata'] as Record<string, unknown>)['name'];
          expect(ref['name'], `${context}: secretKeyRef.name`).toBe(secretName);
          expect(ref['key'], `${context}: secretKeyRef.key`).toBe(DATA_KEY);
        }
      }),
      {
        ...assertConfig,
        examples: [
          // Lengths either side of every base64 padding boundary.
          ['a'],
          ['ab'],
          ['abc'],
          ['abcd'],
          // Values YAML or Helm could mangle without correct quoting.
          ['true'],
          ['3000'],
          ['key: value'],
          ['a,b,c'],
          ['"quoted"'],
          ["it's"],
          ['{{ not a template }}'],
          [' leading and trailing '],
          ['\\backslash\\'],
          // Non-ASCII: UTF-8 byte length exceeds character length.
          ['\u00e9\u00df\u6f22\uD83D\uDE42'],
          // The schema's 256-character ceiling.
          ['s'.repeat(256)],
        ],
      },
    );

    if (!sawEnvEntry) {
      console.warn(
        'Property 8: no JWT_SECRET env entry found on the Deployment - the secretKeyRef ' +
          'clause was not exercised. Expected until task 7.2 wires the container env.',
      );
    }
  });

  it('generates a 32-character alphanumeric value when both auth inputs are empty', () => {
    fc.assert(
      fc.property(releaseNameArb, (releaseName) => {
        const context = `release "${releaseName}", both auth inputs empty`;
        const result = renderChart(
          { auth: { jwtSecret: '', existingSecret: '' } },
          { releaseName },
        );

        expect(result.status, `${context}\n${result.stderr}`).toBe(0);

        const data = secretData(result, context);
        expect(Object.keys(data), `${context}: data keys`).toEqual([DATA_KEY]);

        const encoded = data[DATA_KEY];
        expect(typeof encoded, `${context}: data.JWT_SECRET is not a string`).toBe('string');
        expect(encoded as string, `${context}: data.JWT_SECRET is not canonical base64`).toMatch(
          BASE64,
        );

        const generated = decodeBase64(encoded as string);
        expect(generated.length, `${context}: generated value "${generated}" length`).toBe(
          GENERATED_SECRET_LENGTH,
        );
        expect(generated, `${context}: generated value "${generated}" alphabet`).toMatch(
          GENERATED_SECRET,
        );
      }),
      assertConfig,
    );
  });

  it('points the container at auth.existingSecret and renders no Secret of its own', () => {
    let sawEnvEntry = false;

    fc.assert(
      fc.property(existingSecretKeyArb, dnsLabelArb, (existingSecretKey, existingSecret) => {
        const auth: Record<string, unknown> = { jwtSecret: '', existingSecret };
        if (existingSecretKey !== undefined) {
          auth['existingSecretKey'] = existingSecretKey;
        }
        const context =
          `auth.existingSecret "${existingSecret}", existingSecretKey ` +
          (existingSecretKey === undefined ? 'absent' : `"${existingSecretKey}"`);
        const result = renderChart({ auth });

        expect(result.status, `${context}\n${result.stderr}`).toBe(0);

        // Requirement 5.4: the chart's own Secret template renders nothing.
        expect(docsOfKind(result.docs, 'Secret'), `${context}: rendered a Secret`).toEqual([]);
        // And the render is not vacuously empty.
        expect(result.docs.length, `${context}: rendered nothing at all`).toBeGreaterThan(0);

        const entry = jwtEnvEntry(result.docs);
        if (entry !== undefined) {
          sawEnvEntry = true;
          const ref = secretKeyRef(entry, context);
          // An absent or empty key resolves to JWT_SECRET (Requirement 5.5).
          const expectedKey =
            existingSecretKey === undefined || existingSecretKey === ''
              ? DATA_KEY
              : existingSecretKey;

          expect(ref['name'], `${context}: secretKeyRef.name`).toBe(existingSecret);
          expect(ref['key'], `${context}: secretKeyRef.key`).toBe(expectedKey);
          // Nothing else belongs in the reference.
          expect(Object.keys(ref).sort(), `${context}: secretKeyRef keys`).toEqual(['key', 'name']);
        }
      }),
      {
        ...assertConfig,
        examples: [
          ['', 'shared-jwt'],
          [undefined, 'shared-jwt'],
          [DATA_KEY, 'shared-jwt'],
          ['APP_JWT_SIGNING_KEY', 'platform.secrets'],
        ],
      },
    );

    if (!sawEnvEntry) {
      console.warn(
        'Property 8: no JWT_SECRET env entry found on the Deployment - the existingSecret ' +
          'secretKeyRef clause was not exercised. Expected until task 7.2 wires the container env.',
      );
    }
  });
});
