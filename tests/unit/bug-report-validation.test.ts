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

  it('counts body length in Unicode code points', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '😀😀😀😀',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects entry ids outside the PostgreSQL integer range', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '实时积分对不上显示',
        entryId: 2_147_483_648,
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

  it('accepts a private screenshot object key and rejects ambiguous screenshot inputs', () => {
    const submissionId = '550e8400-e29b-41d4-a716-446655440000';
    const report = validateBugReportCreateInput({
      source: 'website',
      body: '截图上传后无法查看',
      submissionId,
      screenshotObjectKey: `bug-reports/${submissionId}.png`,
    });
    expect(report.submissionId).toBe(submissionId);
    expect(report.screenshotObjectKey).toBe(`bug-reports/${submissionId}.png`);
    expect(report.screenshotUrl).toBeNull();

    const uppercaseReport = validateBugReportCreateInput({
      source: 'website',
      body: '大小写对象键仍应绑定提交',
      submissionId: submissionId.toUpperCase(),
      screenshotObjectKey: `bug-reports/${submissionId.toUpperCase()}.PNG`,
    });
    expect(uppercaseReport.screenshotObjectKey).toBe(
      `bug-reports/${submissionId.toUpperCase()}.PNG`,
    );

    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '截图字段不能同时使用',
        submissionId,
        screenshotObjectKey: `bug-reports/${submissionId}.png`,
        screenshotUrl: 'https://example.com/shot.png',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects object keys outside the strict private screenshot path', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '对象键格式不正确',
        submissionId: '550e8400-e29b-41d4-a716-446655440000',
        screenshotObjectKey: 'bug-reports/not-a-uuid.svg',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a screenshot object key owned by another submission', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '截图对象必须绑定当前提交',
        submissionId: '550e8400-e29b-41d4-a716-446655440000',
        screenshotObjectKey: 'bug-reports/650e8400-e29b-41d4-a716-446655440000.png',
      }),
    ).toThrow(ValidationError);
  });

  it('creates public ids in the LL-XXXXXX shape', () => {
    expect(createPublicBugReportId()).toMatch(/^LL-[0-9A-F]{6}$/);
  });
});
