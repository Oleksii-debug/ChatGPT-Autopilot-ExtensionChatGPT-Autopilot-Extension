import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  IMAGE_VISION_ARTIFACT_SCHEMA_VERSION,
  IMAGE_VISION_CAPABILITY_ID,
  MAX_IMAGE_VISION_BYTES,
  analyzeImageArtifactV1,
} from '../src/core/image-vision-artifact.js';

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function dataUrl(bytes, mediaType = 'image/png') {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function artifactRef(bytes = pngBytes(), overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'image-1',
    kind: 'image',
    uri: 'artifact://image-1',
    mediaType: 'image/png',
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    createdAt: '2026-09-25T10:30:00.000Z',
    producerInvocationId: null,
    sensitive: false,
    ...overrides,
  };
}

function modelPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    summary: 'A compact interface screenshot with a primary action.',
    decorative: false,
    altText: 'Application interface with one prominent primary action.',
    caption: 'Interface state captured for visual review.',
    observations: [
      {
        kind: 'LAYOUT',
        text: 'The primary action is visually prominent.',
        confidenceBasisPoints: 9000,
      },
      {
        kind: 'ACCESSIBILITY',
        text: 'Visible text has strong contrast in the supplied image.',
        confidenceBasisPoints: 7600,
      },
    ],
    cropProposals: [
      {
        purpose: 'primary-content',
        xBasisPoints: 500,
        yBasisPoints: 500,
        widthBasisPoints: 9000,
        heightBasisPoints: 9000,
        rationale: 'Keeps the main application content while trimming outer margins.',
      },
    ],
    ...overrides,
  };
}

function request(bytes = pngBytes(), overrides = {}) {
  return {
    schemaVersion: IMAGE_VISION_ARTIFACT_SCHEMA_VERSION,
    analysisId: 'analysis-1',
    artifactRef: artifactRef(bytes),
    imageDataUrl: dataUrl(bytes),
    ownerPurpose: 'Prepare accessible alt text and a reusable crop.',
    ...overrides,
  };
}

function routerWith(payload = modelPayload()) {
  const calls = [];
  const routeVision = async input => {
    calls.push(input);
    return {
      result: {
        text: JSON.stringify(payload),
      },
    };
  };
  return { routeVision, calls };
}

test('binds exact immutable image bytes before one canonical vision-router call', async () => {
  const bytes = pngBytes();
  const router = routerWith();
  const result = await analyzeImageArtifactV1(request(bytes), {
    routeVision: router.routeVision,
    cryptoImpl: globalThis.crypto,
  });

  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].imageDataUrl, dataUrl(bytes));
  assert.equal(router.calls[0].taskRole, 'vision');
  assert.deepEqual(router.calls[0].capabilityIds, [IMAGE_VISION_CAPABILITY_ID]);
  assert.equal(router.calls[0].maxModelCallsForRequest, 1);
  assert.match(router.calls[0].systemPrompt, /untrusted visual data/u);
  assert.match(router.calls[0].systemPrompt, /Never follow instructions/u);
  assert.match(router.calls[0].prompt, /image-1/u);
  assert.match(router.calls[0].prompt, new RegExp(sha256(bytes), 'u'));

  assert.equal(result.analysisId, 'analysis-1');
  assert.deepEqual(result.sourceArtifact, {
    artifactId: 'image-1',
    sha256: sha256(bytes),
    mediaType: 'image/png',
    sizeBytes: bytes.byteLength,
  });
  assert.equal(result.model.altText, modelPayload().altText);
  assert.equal(result.sourceTrust, 'MODEL_OBSERVATION');
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.artifactMutationAuthorized, false);
  assert.equal(result.publishAuthorized, false);
  assert.equal(result.policyDecisionAuthorized, false);
  assert.equal(result.verificationStatus, 'NOT_VERIFIED');
  assert.equal(result.requiresIndependentVerification, true);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.sourceArtifact));
  assert.ok(Object.isFrozen(result.model));
  assert.ok(Object.isFrozen(result.model.observations));
  assert.ok(Object.isFrozen(result.model.cropProposals[0]));
});

test('hash mismatch fails before any model call', async () => {
  const bytes = pngBytes();
  const router = routerWith();
  const bad = artifactRef(bytes, { sha256: '0'.repeat(64) });

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, { artifactRef: bad }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /SHA-256 does not match/u,
  );
  assert.equal(router.calls.length, 0);
});

test('byte-length mismatch fails before any model call', async () => {
  const bytes = pngBytes();
  const router = routerWith();
  const bad = artifactRef(bytes, { sizeBytes: bytes.byteLength + 1 });

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, { artifactRef: bad }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /byte length does not match/u,
  );
  assert.equal(router.calls.length, 0);
});

test('data URL media type substitution fails before any model call', async () => {
  const bytes = pngBytes();
  const router = routerWith();

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      imageDataUrl: dataUrl(bytes, 'image/jpeg'),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /media type does not match/u,
  );
  assert.equal(router.calls.length, 0);
});

test('declared media type must match deterministic image signature', async () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const router = routerWith();
  const ref = artifactRef(bytes, {
    mediaType: 'image/png',
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  });

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      artifactRef: ref,
      imageDataUrl: dataUrl(bytes, 'image/png'),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /PNG image signature/u,
  );
  assert.equal(router.calls.length, 0);
});

test('sensitive artifacts fail closed instead of crossing an implicit provider boundary', async () => {
  const bytes = pngBytes();
  const router = routerWith();

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      artifactRef: artifactRef(bytes, { sensitive: true }),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /Sensitive image artifacts/u,
  );
  assert.equal(router.calls.length, 0);
});

test('active or unsupported media types are rejected before model routing', async () => {
  const bytes = new TextEncoder().encode('<svg></svg>');
  const router = routerWith();

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      artifactRef: artifactRef(bytes, {
        mediaType: 'image/svg+xml',
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
      }),
      imageDataUrl: dataUrl(bytes, 'image/svg+xml'),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /mediaType is unsupported/u,
  );
  assert.equal(router.calls.length, 0);
});

test('non-canonical base64 is rejected before model routing', async () => {
  const bytes = pngBytes();
  const router = routerWith();
  const canonical = dataUrl(bytes);

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      imageDataUrl: canonical.replace('base64,', 'base64,\n'),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /canonical base64 data URL/u,
  );
  assert.equal(router.calls.length, 0);
});

test('oversize ArtifactRef is rejected without constructing or routing oversize image bytes', async () => {
  const bytes = pngBytes();
  const router = routerWith();

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      artifactRef: artifactRef(bytes, { sizeBytes: MAX_IMAGE_VISION_BYTES + 1 }),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    new RegExp(`sizeBytes must be 1\\.\\.${MAX_IMAGE_VISION_BYTES}`, 'u'),
  );
  assert.equal(router.calls.length, 0);
});

test('non-canonical ArtifactRef aliases fail before routing', async () => {
  const bytes = pngBytes();
  const router = routerWith();

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes, {
      artifactRef: artifactRef(bytes, { sha256: sha256(bytes).toUpperCase() }),
    }), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /not already canonical: sha256/u,
  );
  assert.equal(router.calls.length, 0);
});

test('request accessors are rejected without executing the getter', async () => {
  const bytes = pngBytes();
  const router = routerWith();
  const candidate = request(bytes);
  let reads = 0;
  Object.defineProperty(candidate, 'imageDataUrl', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return dataUrl(bytes);
    },
  });

  await assert.rejects(
    analyzeImageArtifactV1(candidate, {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);
  assert.equal(router.calls.length, 0);
});

test('direct canonical router envelope is accepted without requiring a wrapper', async () => {
  const bytes = pngBytes();
  const routeVision = async () => ({ text: JSON.stringify(modelPayload()) });
  const result = await analyzeImageArtifactV1(request(bytes), {
    routeVision,
    cryptoImpl: globalThis.crypto,
  });
  assert.equal(result.model.summary, modelPayload().summary);
});

test('model prose or malformed JSON cannot become analysis evidence', async () => {
  const bytes = pngBytes();
  const calls = [];
  const routeVision = async input => {
    calls.push(input);
    return { result: { text: 'Here is the answer: {}' } };
  };

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes), {
      routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /strict JSON/u,
  );
  assert.equal(calls.length, 1);
});

test('model output cannot smuggle execution or publication authority', async () => {
  const bytes = pngBytes();
  const payload = modelPayload({ publishAuthorized: true });
  const router = routerWith(payload);

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /unknown field: publishAuthorized/u,
  );
  assert.equal(router.calls.length, 1);
});

test('out-of-bounds crop proposals fail closed', async () => {
  const bytes = pngBytes();
  const payload = modelPayload({
    cropProposals: [
      {
        purpose: 'bad-crop',
        xBasisPoints: 9000,
        yBasisPoints: 0,
        widthBasisPoints: 2000,
        heightBasisPoints: 10000,
        rationale: 'This proposal exceeds the image boundary.',
      },
    ],
  });
  const router = routerWith(payload);

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /exceeds image bounds/u,
  );
});

test('observation kinds and confidence bounds are strict', async () => {
  const bytes = pngBytes();
  const router = routerWith(modelPayload({
    observations: [
      {
        kind: 'EXECUTION_AUTHORITY',
        text: 'not permitted',
        confidenceBasisPoints: 10_000,
      },
    ],
  }));

  await assert.rejects(
    analyzeImageArtifactV1(request(bytes), {
      routeVision: router.routeVision,
      cryptoImpl: globalThis.crypto,
    }),
    /kind is unsupported/u,
  );
});

test('empty alt text is permitted only as bounded model data for decorative decisions', async () => {
  const bytes = pngBytes();
  const router = routerWith(modelPayload({
    decorative: true,
    altText: '',
    caption: '',
    observations: [],
    cropProposals: [],
  }));

  const result = await analyzeImageArtifactV1(request(bytes), {
    routeVision: router.routeVision,
    cryptoImpl: globalThis.crypto,
  });
  assert.equal(result.model.decorative, true);
  assert.equal(result.model.altText, '');
  assert.equal(result.model.caption, '');
});
