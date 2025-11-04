import { syncCurrentPlayerValues } from '../src/services/player-values.service';

async function main() {
  const result = await syncCurrentPlayerValues();
  console.log('syncCurrentPlayerValues result:', result);
}

void main();
