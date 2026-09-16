/* eslint-disable no-console */
import { parseArgs } from 'node:util';

export function parseCorrectionArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      season: { type: 'string' },
      entry: { type: 'string' },
      event: { type: 'string' },
      'expected-publication': { type: 'string' },
      'expected-generation': { type: 'string' },
      'change-id': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const entryId = Number(values.entry),
    eventId = Number(values.event),
    generation = Number(values['expected-generation']);
  if (
    !values.season ||
    !/^[0-9]{4}$/.test(values.season) ||
    ![entryId, eventId, generation].every((n) => Number.isSafeInteger(n) && n > 0) ||
    eventId > 38 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      values['expected-publication'] ?? '',
    ) ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(values['change-id'] ?? '')
  ) {
    throw new Error(
      'Provide exact --season --entry --event --expected-publication --expected-generation --change-id; --apply is optional',
    );
  }
  return {
    seasonCode: values.season,
    entryId,
    eventId,
    expectedPublicationId: values['expected-publication']!,
    expectedGeneration: generation,
    changeId: values['change-id']!,
    apply: values.apply,
  };
}

async function main() {
  const { seasonCode, ...args } = parseCorrectionArgs(process.argv.slice(2));
  const { seasonRepository } = await import('../src/repositories/seasons');
  const { correctDeletedEntryFinal } = await import(
    '../src/services/entry-final-correction.service'
  );
  const season = await seasonRepository.findCurrent();
  if (season.seasonCode !== seasonCode)
    throw new Error('Correction is limited to the canonical current season');
  console.log(JSON.stringify(await correctDeletedEntryFinal({ season, ...args })));
}
if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : 'FINAL correction failed');
      process.exit(1);
    },
  );
}
