const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

process.stdout.write(databaseUrl);
