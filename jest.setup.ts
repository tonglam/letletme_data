import dotenv from 'dotenv';
import { resolve } from 'path';

// Load test environment variables
const result = dotenv.config({
  path: resolve(__dirname, '.env.test')
});

if (result.error) {
  console.error('Error loading .env.test file:', result.error);
  process.exit(1);
}

// Verify required environment variables
const requiredEnvVars = ['BOOTSTRAP_API_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}
