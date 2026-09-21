'use strict';

const PRIMARY_REPOSITORY = 'g1at/Relay';
const LEGACY_REPOSITORY = 'g1at/relay-updates';
const MIGRATION_VERSION = '3.0.1';
const UPDATE_FEED = Object.freeze({ provider: 'github', owner: 'g1at', repo: 'Relay' });

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Release version must be a stable X.Y.Z version.');
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Release version is out of range.');
  return parts;
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function releasePolicy(version) {
  if (compareVersions(version, MIGRATION_VERSION) < 0) {
    throw new Error('Releases older than 3.0.1 are immutable; do not replace the existing 3.0.0 installer.');
  }
  return {
    version, tag: `v${version}`, feed: { ...UPDATE_FEED },
    repositories: version === MIGRATION_VERSION ? [PRIMARY_REPOSITORY, LEGACY_REPOSITORY] : [PRIMARY_REPOSITORY],
  };
}

function assertUpdateFeed(feed) {
  if (!feed || Array.isArray(feed) || typeof feed !== 'object'
      || Object.entries(UPDATE_FEED).some(([key, value]) => feed[key] !== value)
      || (feed.host !== undefined && feed.host !== 'github.com')
      || feed.private === true || feed.token !== undefined || feed.requestHeaders !== undefined) {
    throw new Error('The packaged update feed must point only to public g1at/Relay, without embedded credentials.');
  }
}

function assertPackagePolicy(manifest) {
  const policy = releasePolicy(manifest?.version);
  assertUpdateFeed(manifest?.build?.publish);
  return policy;
}

function assertRemoteRepository(repository, metadata) {
  if (!metadata || metadata.full_name?.toLowerCase() !== repository.toLowerCase()
      || metadata.private !== false || metadata.visibility !== 'public'
      || metadata.archived === true || metadata.disabled === true) {
    throw new Error(`${repository} must already be PUBLIC and writable before publication. Its visibility will not be changed.`);
  }
}

function assertNewRelease(policy, repository, releases, matchingRefs) {
  if (!policy.repositories.includes(repository) || !Array.isArray(releases) || !Array.isArray(matchingRefs)) {
    throw new Error('Release preflight returned an invalid repository or response.');
  }
  if (releases.some(release => release?.tag_name === policy.tag)
      || matchingRefs.some(ref => ref?.ref === `refs/tags/${policy.tag}`)) {
    throw new Error(`${repository} ${policy.tag} already exists; releases and tags are never overwritten.`);
  }
  for (const release of releases) {
    if (release?.draft || release?.prerelease) continue;
    const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release?.tag_name || '');
    if (match && compareVersions(policy.version, match[1]) <= 0) {
      throw new Error(`${repository}: ${policy.version} must be newer than existing stable release ${match[1]}.`);
    }
  }
}

module.exports = { PRIMARY_REPOSITORY, LEGACY_REPOSITORY, MIGRATION_VERSION, UPDATE_FEED,
  versionParts, compareVersions, releasePolicy, assertUpdateFeed, assertPackagePolicy, assertRemoteRepository, assertNewRelease };
