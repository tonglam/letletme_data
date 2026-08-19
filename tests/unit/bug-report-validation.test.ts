import { describe, expect, it } from 'bun:test';

import { createPublicBugReportId, validateBugReportCreateInput } from '../../src/domain/bug-report';
import { ValidationError } from '../../src/utils/errors';

describe('bug report validation', () => {
  it('accepts a short plain-language description and assigns a public id', () => {
    const report = validateBugReportCreateInput({
      source: 'wechat_miniprogram',
      body: '首页一直转圈转不出来',
      clientMeta: { route: 'pages/home/index/index' },
    });

    expect(report.publicId).toMatch(/^LL-[0-9A-F]{6}$/);
    expect(report.body).toBe('首页一直转圈转不出来');
    expect(report.userId).toBeNull();
    expect(report.entryId).toBeNull();
  });

  it('rejects descriptions that are too short', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '坏了',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects http screenshot URLs', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '实时积分对不上显示',
        screenshotUrl: 'http://example.com/shot.png',
      }),
    ).toThrow(ValidationError);
  });

  it('creates public ids in the LL-XXXXXX shape', () => {
    expect(createPublicBugReportId()).toMatch(/^LL-[0-9A-F]{6}$/);
  });
});
