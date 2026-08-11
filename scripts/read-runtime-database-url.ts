const variableName = process.argv[2] ?? 'DATABASE_URL';
const databaseUrl = process.env[variableName]?.trim();

if (!databaseUrl) {
  console.error(`${variableName} is required`);
  process.exit(1);
}

process.stdout.write(databaseUrl);
