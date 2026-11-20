import type { VerifyWarningException } from '../schemas/config.schema.js';
import type { VerifyFinding } from './verify.js';

export function partitionVerifyFindings(
  project: string,
  findings: VerifyFinding[],
  exceptions: VerifyWarningException[],
): {
  errors: VerifyFinding[];
  warnings: VerifyFinding[];
  exemptedWarnings: Array<{
    finding: VerifyFinding;
    exception: VerifyWarningException;
  }>;
} {
  const exceptionByKey = new Map(
    exceptions.map((exception) => [
      `${exception.project}\u0000${exception.flowId}\u0000${exception.code}`,
      exception,
    ]),
  );
  const result = {
    errors: [] as VerifyFinding[],
    warnings: [] as VerifyFinding[],
    exemptedWarnings: [] as Array<{
      finding: VerifyFinding;
      exception: VerifyWarningException;
    }>,
  };

  for (const item of findings) {
    if (item.level === 'error') {
      result.errors.push(item);
      continue;
    }
    const exception = exceptionByKey.get(
      `${project}\u0000${item.flowId}\u0000${item.code}`,
    );
    if (exception) result.exemptedWarnings.push({ finding: item, exception });
    else result.warnings.push(item);
  }

  return result;
}
