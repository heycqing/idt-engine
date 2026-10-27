import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { artifactStem } from '../../../src/idt/core/artifact-name.js';

const flowId = 'flow_xxxxxxxxxx';

describe('artifactStem', () => {
  it('converts a multi-segment route to a hyphenated slug', () => {
    assert.equal(
      artifactStem({ initialRoute: '/credit/finance/cash-repay', flowId }),
      'credit-finance-cash-repay__flow_xxxxxxxxxx',
    );
  });

  it('uses root when the route contains no slug characters', () => {
    assert.equal(
      artifactStem({ initialRoute: '/', flowId }),
      'root__flow_xxxxxxxxxx',
    );
  });

  it('lowercases uppercase route characters', () => {
    assert.equal(
      artifactStem({ initialRoute: '/plan/aiznwgIntro', flowId }),
      'plan-aiznwgintro__flow_xxxxxxxxxx',
    );
  });

  it('replaces Chinese, colon, and dot characters with hyphens', () => {
    assert.equal(
      artifactStem({ initialRoute: '/中文/:account/detail.v2', flowId }),
      'account-detail-v2__flow_xxxxxxxxxx',
    );
  });

  it('collapses consecutive separators and removes leading and trailing hyphens', () => {
    assert.equal(
      artifactStem({ initialRoute: '/---alpha///::beta...---/', flowId }),
      'alpha-beta__flow_xxxxxxxxxx',
    );
  });

  it('truncates a long slug to 40 characters without a trailing hyphen', () => {
    const stem = artifactStem({
      initialRoute: '/1234567890123456789012345678901234567890/extra',
      flowId,
    });
    const slug = stem.split('__')[0];

    assert.equal(slug, '1234567890123456789012345678901234567890');
    assert.equal(slug.length, 40);
    assert.equal(slug.endsWith('-'), false);
  });

  it('keeps stems unique for different flowIds on the same route', () => {
    assert.notEqual(
      artifactStem({ initialRoute: '/h5/aiznwg', flowId: 'flow_aaaaaaaaaa' }),
      artifactStem({ initialRoute: '/h5/aiznwg', flowId: 'flow_bbbbbbbbbb' }),
    );
  });

  it('returns the same stem for the same IR every time', () => {
    const ir = { initialRoute: '/h5/aiznwg', flowId };

    assert.equal(artifactStem(ir), artifactStem(ir));
  });
});
