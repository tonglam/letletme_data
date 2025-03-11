import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables
const result = dotenv.config({
  path: resolve(__dirname, '.env'),
});

if (result.error) {
  console.error('Error loading .env file:', result.error);
  process.exit(1);
}

// Verify required environment variables
const requiredEnvVars = ['REDIS_HOST', 'REDIS_PORT'];
const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

// Tests will run on demand without timeouts
// Each test file should use the test.concurrent.only() pattern when needed

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.REDIS_PASSWORD = undefined;
