// Builds the MCP Apps cards once before the test run, so `npm test` works on a
// clean checkout without a prior `npm run build`.
import { buildUi } from '../scripts/build-ui.mjs';

export default async function setup() {
  await buildUi({ quiet: true });
}
