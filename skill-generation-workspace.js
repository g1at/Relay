'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanPackage, sameManifest, SkillDraftError } = require('./skill-draft-service');

// Keep the input snapshot outside the model's editable staging directory. Every
// candidate must retain the exact base it was generated from, even if the live
// library is edited, imported or receives presentation metadata during a run.
function prepareSkillGenerationWorkspace({ skillsDir, workspaceRoot }) {
  const root = path.resolve(workspaceRoot);
  const baseDir = path.join(root, 'base');
  const stagingRoot = path.join(root, 'proposed');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root); // Never reuse or clean another active run's workspace.
  try {
    fs.mkdirSync(baseDir);
    fs.mkdirSync(stagingRoot);
    const entries = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true }) : [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const source = path.join(skillsDir, entry.name);
      if (!fs.existsSync(path.join(source, 'SKILL.md'))) continue;
      const before = scanPackage(source);
      const snapshot = path.join(baseDir, entry.name);
      fs.cpSync(source, snapshot, { recursive: true, force: false, errorOnExist: true });
      const frozen = scanPackage(snapshot);
      if (!sameManifest(before, frozen) || !sameManifest(before, scanPackage(source))) {
        throw new SkillDraftError('BASE_CAPTURE_CONFLICT', 'Skill changed while its generation baseline was captured');
      }
      const candidate = path.join(stagingRoot, entry.name);
      fs.cpSync(snapshot, candidate, { recursive: true, force: false, errorOnExist: true });
      if (!sameManifest(frozen, scanPackage(candidate))) {
        throw new SkillDraftError('BASE_CAPTURE_CONFLICT', 'Candidate copy does not match its generation baseline');
      }
    }
    return { workspaceRoot: root, stagingRoot, baseDir };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { prepareSkillGenerationWorkspace };
