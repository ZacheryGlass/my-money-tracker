'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function writePrivateReport(outputPath, report) {
  if (!outputPath || !path.isAbsolute(outputPath)) {
    throw new Error('--output must be an explicit absolute path');
  }
  const outputDirectory = path.dirname(outputPath);
  const containingWorktree = spawnSync(
    'git', ['-C', outputDirectory, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  if (containingWorktree.status === 0) {
    const repositoryRoot = String(containingWorktree.stdout || '').trim();
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', outputPath], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    if (ignored.status !== 0) {
      throw new Error('--output inside a Git worktree must be gitignored');
    }
  }
  const descriptor = fs.openSync(outputPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    try { fs.unlinkSync(outputPath); } catch {
      // Preserve the original write failure; cleanup is best-effort only.
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { writePrivateReport };
