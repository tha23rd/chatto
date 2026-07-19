import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStableParaglideSources } from './i18n-facade-sources.mjs';

const completeSource = `
/** @typedef {{ name: string }} GreetingInputs */
export const greeting = () => 'Hello';
`;
const completeIndex = 'export { greeting as "greeting" }\n';

test('waits for stable complete Paraglide outputs', async () => {
  const snapshots = [
    { source: '/* generated header */\n', index: '' },
    { source: completeSource, index: completeIndex },
    { source: completeSource, index: completeIndex }
  ];
  let attempt = 0;
  let waits = 0;

  const result = await readStableParaglideSources({
    readSource: () => snapshots[Math.min(attempt, snapshots.length - 1)].source,
    readIndex: () => snapshots[Math.min(attempt++, snapshots.length - 1)].index,
    wait: async () => {
      waits++;
    },
    maxAttempts: 5
  });

  assert.deepEqual(result.functionNames, ['greeting']);
  assert.equal(result.aliases.get('greeting'), 'greeting');
  assert.equal(result.typeNames.get('GreetingInputs'), '{ name: string }');
  assert.equal(waits, 2);
});
