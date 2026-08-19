import { validateBugReportCreateInput, type BugReportCreateInput } from '../domain/bug-report';
import { bugReportRepository } from '../repositories/bug-reports';

export const createBugReport = async (input: BugReportCreateInput) => {
  const report = validateBugReportCreateInput(input);
  const stored = await bugReportRepository.insert(report);
  return { publicId: stored.publicId };
};
