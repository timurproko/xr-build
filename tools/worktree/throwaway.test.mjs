import test from 'node:test';
import assert from 'node:assert/strict';

test('throwaway: fails on purpose to exercise nightly triage', () => assert.equal(1, 2));
