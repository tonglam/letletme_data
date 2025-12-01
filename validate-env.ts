import 'dotenv/config';
import { validateEnvForCli } from './src/utils/config';

const result = validateEnvForCli();
if (!result.ok) {
  process.exit(1);
}
