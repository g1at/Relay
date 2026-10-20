'use strict';

// The SDK's message iterator can finish before its native child exits. Keep a
// separate host-owned stop deadline and never treat kill()'s return as exit.
class SdkProcessSupervisor {
  constructor({ graceMs = 2000, retryMs = 250, onExit, onLifecycle } = {}) {
    this.graceMs = Math.max(0, graceMs);
    this.retryMs = Math.max(0, retryMs);
    this.onExit = onExit;
    this.onLifecycle = onLifecycle;
    this.child = null;
    this.spawnSettled = false;
    this.stopRequestedAt = null;
    this.lastForceAt = null;
    this.forceAttempts = 0;
    this.timer = null;
    this.result = null;
    this.rootExit = null;
    this.confirmingTree = null;
    this.lastErrorCode = null;
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
  }

  snapshot() {
    return { pid: this.child?.pid || null, stopRequested: this.stopRequestedAt !== null,
      spawnSettled: this.spawnSettled, forceAttempts: this.forceAttempts,
      sdkPid: this.child?.sdkPid || null, processTree: !!this.child?.relayProcessTree,
      exited: !!this.result, lastErrorCode: this.lastErrorCode };
  }

  _notify(type, detail = {}) {
    try { this.onLifecycle?.({ type, ...this.snapshot(), ...detail }); } catch (_) {}
  }

  _finish(result) {
    if (this.result) return;
    if (this.child?.relayProcessTree && !result.treeConfirmed) {
      this.rootExit = result;
      this._confirmTree();
      return;
    }
    clearTimeout(this.timer); this.timer = null;
    this.result = { pid: this.child?.pid || null, exitCode: null, signal: null,
      forced: this.forceAttempts > 0, ...result, stopConfirmed: true };
    this._notify('exit', this.result);
    this.resolveExited(this.result);
    try { this.onExit?.(this.result); } catch (_) {}
  }

  _confirmTree() {
    if (this.result || !this.rootExit || this.confirmingTree) return;
    const tree = this.child.relayProcessTree;
    this.confirmingTree = Promise.resolve().then(() => tree.confirmStopped()).then(receipt => {
      if (receipt?.stopConfirmed !== true || receipt.activeProcesses !== 0 || receipt.pendingExits !== 0 ||
          !tree.scopeId || receipt.scopeId !== tree.scopeId) {
        throw Object.assign(Error('SDK process tree exit has not been confirmed'), { code: 'SDK_PROCESS_TREE_UNCONFIRMED' });
      }
      tree.closeConfirmed();
      this._finish({ ...this.rootExit, ...receipt, treeConfirmed: true });
    }).catch(error => {
      this.lastErrorCode = String(error?.code || 'SDK_PROCESS_TREE_CONFIRM_FAILED');
      this._notify('process-tree-unconfirmed', { code: this.lastErrorCode });
    }).finally(() => {
      this.confirmingTree = null;
      if (!this.result && !this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this._confirmTree(); }, Math.max(250, this.retryMs));
        this.timer.unref?.();
      }
    });
  }

  attach(child) {
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      throw new TypeError('A real spawned process is required');
    }
    if (this.child === child) return child;
    if (this.child || this.spawnSettled || this.result) {
      throw new Error('Cannot attach a process after spawn has settled');
    }
    this.child = child;
    child.once('exit', (exitCode, signal) => this._finish({ exitCode, signal }));
    child.on('error', error => {
      this.lastErrorCode = String(error?.code || 'PROCESS_ERROR');
      this._notify('process-error', { code: this.lastErrorCode });
      // An error with a PID can be a failed signal, not a failed spawn.
      if (!child.pid) this._finish({ spawnFailed: true, errorCode: this.lastErrorCode });
    });
    this._notify('attached');
    if (child.exitCode != null || child.signalCode != null) {
      this._finish({ exitCode: child.exitCode, signal: child.signalCode });
    } else if (this.stopRequestedAt !== null) this._scheduleForce();
    return child;
  }

  // Call only once no future asynchronous launch path can spawn another child.
  markSpawnSettled() {
    this.spawnSettled = true;
    if (!this.child) this._finish({ notSpawned: true });
    return this.exited;
  }

  _scheduleForce() {
    if (this.result || !this.child || this.timer) return;
    const delay = Math.max(0, this.stopRequestedAt + this.graceMs - Date.now(),
      this.lastForceAt === null ? 0 : this.lastForceAt + this.retryMs - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this._force(); }, delay);
    this.timer.unref?.();
  }

  _force() {
    if (this.result || !this.child || this.stopRequestedAt === null) return;
    // exitCode/signalCode are native exit observations; killed only means that
    // a prior signal was sent, so it must not suppress escalation or retries.
    if (this.child.exitCode != null || this.child.signalCode != null) {
      this._finish({ exitCode: this.child.exitCode, signal: this.child.signalCode });
      return;
    }
    this.lastForceAt = Date.now(); this.forceAttempts++;
    try {
      const accepted = this.child.kill('SIGKILL');
      this._notify('force-signal', { accepted: accepted === true });
    } catch (error) {
      this.lastErrorCode = String(error?.code || 'KILL_FAILED');
      this._notify('force-error', { code: this.lastErrorCode });
    }
  }

  stop() {
    if (this.result) return this.exited;
    if (this.stopRequestedAt === null) {
      this.stopRequestedAt = Date.now(); this._notify('stop-requested');
    }
    if (this.rootExit) this._confirmTree();
    else this._scheduleForce();
    return this.exited;
  }

  whenExited() { return this.exited; }
}

module.exports = { SdkProcessSupervisor };
