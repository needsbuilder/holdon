import { describe, expect, it } from 'vitest';
import { evaluateRequest } from '../src/domain/engine.js';
import { engineContext } from './helpers.js';
import { ORDINARY_REQUESTS } from './ordinary-requests.js';

const ctx = engineContext();

describe('ordinary requests', () => {
  it.each(ORDINARY_REQUESTS.map((request) => [request.input.description, request] as const))('%s', (_, { input, verdict }) => {
    expect(evaluateRequest(input, ctx).verdict).toBe(verdict);
  });
});
