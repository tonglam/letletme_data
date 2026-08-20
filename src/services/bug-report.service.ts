import { validateBugReportCreateInput, type BugReportCreateInput } from '../domain/bug-report';
import { bugReportRepository } from '../repositories/bug-reports';
import { DatabaseError } from '../utils/errors';

// One initial allocation plus at most three deterministic collision retries.
const MAX_PUBLIC_ID_ATTEMPTS = 4;

type BugReportRepository = Pick<typeof bugReportRepository, 'insert'>;

export type BugReportServiceDependencies = Readonly<{
  repository?: BugReportRepository;
  publicIdGenerator?: () => string;
}>;

function isPublicIdCollision(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== 'object') return false;
    const record = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (
      record.code === '23505' &&
      (record.constraint ?? record.constraint_name) === 'bug_reports_public_id_key'
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export const createBugReport = async (
  input: BugReportCreateInput,
  dependencies: BugReportServiceDependencies = {},
) => {
  const repository = dependencies.repository ?? bugReportRepository;
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
    const report = validateBugReportCreateInput(input, {
      publicIdGenerator: dependencies.publicIdGenerator,
    });
    try {
      const stored = await repository.insert(report);
      return { publicId: stored.publicId };
    } catch (error) {
      if (isPublicIdCollision(error) && attempt + 1 < MAX_PUBLIC_ID_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }

  throw new DatabaseError('Could not allocate a report id');
};
