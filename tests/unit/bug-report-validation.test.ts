import { describe, expect, it } from 'bun:test';

import {
  bugReportRequestHash,
  createPublicBugReportId,
  validateBugReportCreateInput,
} from '../../src/domain/bug-report';
import { createBugReport } from '../../src/services/bug-report.service';
import { ValidationError } from '../../src/utils/errors';
import { DatabaseError } from '../../src/utils/errors';

describe('bug report validation', () => {
  it('accepts a short plain-language description and assigns a public id', () => {
    const report = validateBugReportCreateInput({
      source: 'wechat_miniprogram',
      body: '首页一直转圈转不出来',
      clientMeta: { route: 'pages/home/index/index' },
    });

    expect(report.publicId).toMatch(/^LL-[0-9A-F]{12}$/);
    expect(report.body).toBe('首页一直转圈转不出来');
    expect(report.userId).toBeNull();
    expect(report.entryId).toBeNull();
    expect(report.submissionRequestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects descriptions that are too short', () => {
    expect(() =>
      validateBugReportCreateInput({
        source: 'website',
        body: '坏了',
      }),
    ).toThrow(ValidationError);
  });

  it('hashes the normalized submission request deterministically', () => {
    const first = validateBugReportCreateInput({
      source: 'website',
      body: '确定性请求指纹测试',
      clientMeta: { b: 2, a: { y: true, x: 'one' } },
    });
    const second = validateBugReportCreateInput({
      source: 'website',
      body: '确定性请求指纹测试',
      clientMeta: { a: { x: 'one', y: true }, b: 2 },
    });
    expect(first.submissionRequestHash).toBe(second.submissionRequestHash);
  });

  it('keeps retries idempotent when diagnostic metadata gains fields', () => {
    const submissionId = '550e8400-e29b-41d4-a716-446655440000';
    const legacy = validateBugReportCreateInput({
      source: 'website',
      body: '诊断字段升级仍应保持幂等',
      submissionId,
      clientMeta: {
        operations: [
          {
            operation: 'PlayersForPicker',
            requestId: 'request-1',
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded',
          },
        ],
      },
    });
    const enriched = validateBugReportCreateInput({
      source: 'website',
      body: '诊断字段升级仍应保持幂等',
      submissionId,
      clientMeta: {
        operations: [
          {
            at: '2026-08-24T00:00:00.000Z',
            operation: 'PlayersForPicker',
            requestId: 'request-1',
            code: 'RATE_LIMITED',
            status: 429,
            retryAfterSeconds: 15,
            rateLimitPolicy: 'graphql-v4',
            rateLimitScope: 'workload',
            workload: 'player-stats',
            message: 'Rate limit exceeded',
          },
        ],
      },
    });

    expect(enriched.submissionRequestHash).toBe(legacy.submissionRequestHash);
    expect(enriched.submissionRequestHash).toBe(
      bugReportRequestHash({
        source: 'website',
        userId: null,
        entryId: null,
        body: '诊断字段升级仍应保持幂等',
        submissionId,
        screenshotObjectKey: null,
        screenshotUrl: null,
        clientMeta: {
          operations: [
            {
              operation: 'PlayersForPicker',
              requestId: 'request-1',
              code: 'RATE_LIMITED',
              message: 'Rate limit exceeded',
            },
          ],
        },
      }),
    );
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
        body: '截图归属必须和提交一致',
        submissionId: '550e8400-e29b-41d4-a716-446655440000',
        screenshotObjectKey: 'bug-reports/550e8400-e29b-41d4-a716-446655440001.png',
      }),
    ).toThrow(ValidationError);
  });

  it('creates public ids in the LL-XXXXXX shape', () => {
    expect(createPublicBugReportId()).toMatch(/^LL-[0-9A-F]{12}$/);
  });

  it('retries an injected public-id collision deterministically', async () => {
    const generated = ['LL-000000000000', 'LL-111111111111'];
    const attempted: string[] = [];
    const repository = {
      insert: async (report: { publicId: string }) => {
        attempted.push(report.publicId);
        if (attempted.length === 1) {
          const cause = Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'bug_reports_public_id_key',
          });
          throw new DatabaseError(
            'duplicate public id',
            '23505',
            cause,
            'bug_reports_public_id_key',
          );
        }
        return { id: 'report-id', publicId: report.publicId, createdAt: new Date() };
      },
    };

    const result = await createBugReport(
      { source: 'website', body: '确定性碰撞重试测试' },
      { repository, publicIdGenerator: () => generated.shift() ?? 'LL-222222222222' },
    );

    expect(attempted).toEqual(['LL-000000000000', 'LL-111111111111']);
    expect(result.publicId).toBe('LL-111111111111');
  });

  it('stops after three public-id collision retries', async () => {
    const attempted: string[] = [];
    const repository = {
      insert: async (report: { publicId: string }) => {
        attempted.push(report.publicId);
        const cause = Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'bug_reports_public_id_key',
        });
        throw new DatabaseError('duplicate public id', '23505', cause, 'bug_reports_public_id_key');
      },
    };

    await expect(
      createBugReport(
        { source: 'website', body: '超过次数后应停止重试' },
        {
          repository,
          publicIdGenerator: () => `LL-${attempted.length.toString(16).padStart(12, '0')}`,
        },
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'bug_reports_public_id_key' });
    expect(attempted).toHaveLength(4);
  });
});
