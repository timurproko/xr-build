import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { workspaceDir } from '../src/env.ts';

test('XRB_HOME names the workspace', () => {
  assert.equal(workspaceDir({ XRB_HOME: 'D:/work/my-xr', USERPROFILE: 'C:/Users/u' }), path.resolve('D:/work/my-xr'));
});

test('default workspace is .xr-build in the user folder', () => {
  assert.equal(workspaceDir({ USERPROFILE: 'C:/Users/u' }), path.join('C:/Users/u', '.xr-build'));
});
