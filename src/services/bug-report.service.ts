import { validateBugReportCreateInput, type BugReportCreateInput } from '../domain/bug-report';
import { bugReportRepository } from '../repositories/bug-reports';
import { DatabaseError } from '../utils/errors';

const MAX_PUBLIC_ID_ATTEMPTS = 5;

function isPublicIdCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  if (record.code !== '23505') return false;
  const constraint = record.constraint ?? record.constraint_name;
  return constraint === 'bug_reports_public_id_key';
}

export const createBugReport = async (input: BugReportCreateInput) => {
  for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
    const report = validateBugReportCreateInput(input);
    try {
      const stored = await bugReportRepository.insert(report);
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
