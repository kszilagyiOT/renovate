const fs = require('fs-extra');
const { join } = require('path');
const os = require('os');
const path = require('path');
const Git = require('simple-git/promise');
const convertHrtime = require('convert-hrtime');

class Storage {
  constructor() {
    let config = {};
    let git = null;
    let repoDir = null;

    Object.assign(this, {
      initRepo,
      cleanRepo,
      setBaseBranch,
      branchExists,
      commitFilesToBranch,
      createBranch,
      deleteBranch,
      getAllRenovateBranches,
      getBranchCommit,
      getBranchLastCommitTime,
      getCommitMessages,
      getFile,
      getFileList,
      isBranchStale,
      mergeBranch,
    });

    async function initRepo(args) {
      cleanRepo();
      logger.info('Initialising git repository');
      config = { ...args };
      repoDir = path.join(
        process.env.RENOVATE_TMPDIR || os.tmpdir(),
        config.platform,
        config.repository
      );
      const gitHead = path.join(repoDir, '.git/HEAD');
      let clone = true;
      // istanbul ignore if
      if (process.env.NODE_ENV !== 'test' && (await fs.exists(gitHead))) {
        try {
          git = Git(repoDir).silent(true);
          await git.raw(['remote', 'set-url', 'origin', config.url]);
          const fetchStart = process.hrtime();
          await git.fetch(config.url, ['--depth=2', '--no-single-branch']);
          await git.raw(['remote', 'prune', 'origin']);
          const fetchSeconds = Math.round(
            convertHrtime(process.hrtime(fetchStart)).seconds
          );
          logger.info({ fetchSeconds }, 'git fetch completed');
          clone = false;
        } catch (err) {
          logger.error({ err }, 'git fetch error');
        }
      }
      if (clone) {
        await fs.emptyDir(repoDir);
        git = Git(repoDir).silent(true);
        const cloneStart = process.hrtime();
        await git.clone(config.url, '.', ['--depth=2', '--no-single-branch']);
        const cloneSeconds = Math.round(
          convertHrtime(process.hrtime(cloneStart)).seconds
        );
        logger.info({ cloneSeconds }, 'git clone completed');
      }

      if (config.gitAuthor) {
        await git.raw(['config', 'user.name', config.gitAuthor.name]);
        await git.raw(['config', 'user.email', config.gitAuthor.address]);
        // not supported yet
        await git.raw(['config', 'commit.gpgsign', 'false']);
      }

      // see https://stackoverflow.com/a/44750379/1438522
      config.baseBranch =
        config.baseBranch ||
        (await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']))
          .replace('refs/remotes/origin/', '')
          .trim();
    }

    async function createBranch(branchName, sha) {
      await git.reset('hard');
      await git.checkout(['-B', branchName, sha]);
      await git.push(['origin', branchName, '--force']);
    }

    // Return the commit SHA for a branch
    async function getBranchCommit(branchName) {
      const res = await git.revparse(['origin/' + branchName]);
      return res.trim();
    }

    async function getCommitMessages() {
      logger.debug('getCommitMessages');
      const res = await git.log({
        n: 10,
        format: { message: '%s' },
      });
      return res.all.map(commit => commit.message);
    }

    function setBaseBranch(branchName) {
      if (branchName) {
        logger.debug(`Setting baseBranch to ${branchName}`);
        config.baseBranch = branchName;
      }
    }

    async function getFileList(branchName) {
      const branch = branchName || config.baseBranch;
      const exists = await branchExists(branch);
      if (!exists) {
        return [];
      }
      const files = await git.raw([
        'ls-tree',
        '-r',
        '--name-only',
        'origin/' + branch,
      ]);
      return files.split('\n').filter(Boolean);
    }

    async function branchExists(branchName) {
      try {
        await git.raw(['show-branch', 'origin/' + branchName]);
        return true;
      } catch (ex) {
        return false;
      }
    }

    async function getAllRenovateBranches(branchPrefix) {
      const branches = await git.branch(['--remotes', '--verbose']);
      return branches.all
        .map(localName)
        .filter(branchName => branchName.startsWith(branchPrefix));
    }

    async function isBranchStale(branchName) {
      const branches = await git.branch([
        '--remotes',
        '--verbose',
        '--contains',
        config.baseBranch,
      ]);
      return !branches.all.map(localName).includes(branchName);
    }

    async function deleteBranch(branchName) {
      await git.raw(['push', '--delete', 'origin', branchName]);
      try {
        await git.deleteLocalBranch(branchName);
      } catch (ex) {
        // local branch may not exist
      }
    }

    async function mergeBranch(branchName) {
      await git.reset('hard');
      await git.checkout(['-B', branchName, 'origin/' + branchName]);
      await git.checkout(config.baseBranch);
      await git.merge([branchName]);
      await git.push('origin', config.baseBranch);
    }

    async function getBranchLastCommitTime(branchName) {
      try {
        const time = await git.show([
          '-s',
          '--format=%ai',
          'origin/' + branchName,
        ]);
        return new Date(Date.parse(time));
      } catch (ex) {
        return new Date();
      }
    }

    async function getFile(filePath, branchName) {
      if (branchName) {
        const exists = await branchExists(branchName);
        if (!exists) {
          logger.warn({ branchName }, 'getFile branch does not exist');
          return null;
        }
      }
      try {
        const content = await git.show([
          'origin/' + (branchName || config.baseBranch) + ':' + filePath,
        ]);
        return content;
      } catch (ex) {
        return null;
      }
    }

    async function commitFilesToBranch(
      branchName,
      files,
      message,
      parentBranch = config.baseBranch
    ) {
      await git.reset('hard');
      await git.checkout(['-B', branchName, 'origin/' + parentBranch]);
      for (const file of files) {
        await fs.writeFile(
          join(repoDir, file.name),
          Buffer.from(file.contents)
        );
      }
      await git.add(files.map(f => f.name));
      await git.commit(message);
      await git.push(['origin', branchName, '--force']);
    }

    function cleanRepo() {}
  }
}

function localName(branchName) {
  return branchName.replace(/^origin\//, '');
}

module.exports = Storage;