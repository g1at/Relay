'use strict';

// An interrupt is a turn boundary, not a process freeze. Keep the conversation
// reserved until both the control response and the old turn have settled.
class LiveTurnControls {
  constructor({ cancelPendingInput, settleUnsent, withTimeout, waitForIdle, killSession }) {
    Object.assign(this, { cancelPendingInput, settleUnsent, withTimeout, waitForIdle, killSession });
    this.operations = new WeakMap();
    this.conversations = new Map();
  }

  isStopping(conversationId) { return !!conversationId && this.conversations.has(conversationId); }

  pendingResult(jobId) {
    for (const operation of this.conversations.values()) {
      if (operation.jobId === jobId) return operation.promise;
    }
    return null;
  }

  _start(target, jobId, conversationId, execute) {
    const existing = this.operations.get(target);
    if (existing && existing.jobId === jobId) return existing.promise;
    const operation = { jobId, conversationId, hold: false, promise: null };
    const release = () => {
      if (this.conversations.get(conversationId) === operation) this.conversations.delete(conversationId);
    };
    this.operations.set(target, operation);
    if (conversationId) this.conversations.set(conversationId, operation);
    operation.promise = Promise.resolve().then(() => execute(operation, release)).finally(() => {
      if (!operation.hold) release();
    });
    return operation.promise;
  }

  async _closed(operation, release, pending, message) {
    // A bounded UI response must not turn an unconfirmed close into permission
    // to start another writer. The reservation survives until actual completion.
    operation.hold = true;
    const closed = Promise.resolve(pending).then((result) => {
      if (result && result.stopConfirmed === false) throw new Error('执行进程尚未确认停止');
      release();
      return result;
    });
    try {
      await this.withTimeout(closed, '等待执行停止', 5000);
      return { aborted: true, settled: true, preservedSession: false, fallback: true, ...(message ? { message } : {}) };
    } catch (error) {
      return { aborted: false, settled: false, preservedSession: false, fallback: true, pending: true,
        message: error.message || '执行尚未停止，请稍后重试' };
    }
  }

  interrupt(session) {
    const jobId = session && session.jobId;
    const existing = session && this.operations.get(session);
    if (existing && (existing.jobId === jobId || !jobId)) return existing.promise;
    if (!session || !jobId || session.busy === false) {
      return Promise.resolve({ aborted: false, settled: true, preservedSession: !!session && !session.dead, alreadyFinished: true });
    }
    return this._start(session, jobId, session.convId, async (operation, release) => {
      const superseded = () => session.jobId && session.jobId !== jobId;
      const finished = () => ({ aborted: false, settled: true, preservedSession: !session.dead, alreadyFinished: true });
      if (superseded() || !session.jobId || session.busy === false) return finished();
      const modePreparationPending = session.pendingInput?.modePreparationPending === true;
      if (this.cancelPendingInput(session)) {
        this.settleUnsent(session, jobId, '已停止，本轮输入尚未发送', true);
        if (modePreparationPending) {
          // Canceling a local mode command closes the SDK Query asynchronously.
          // Wait for that close before allowing a new turn to reuse this session.
          let closed;
          try { closed = this.killSession(session, '暂停模式准备，回收未确认命令'); }
          catch (_) {
            operation.hold = true;
            return { aborted: false, settled: false, preservedSession: false, message: '未能停止执行，请重试' };
          }
          return this._closed(operation, release, closed);
        }
        return { aborted: true, settled: true, preservedSession: true, preparingMcp: true };
      }
      session.turnRouter.interrupt();
      try {
        const receipt = await this.withTimeout(session.child.interrupt(), '中止当前轮', 3000);
        if (superseded()) return finished();
        if (Array.isArray(receipt && receipt.still_queued) && receipt.still_queued.length) {
          // Older CLIs may leave queued input despite the cancellation request.
          // Keep the fallback reservation until those processes really close.
          throw new Error('中止后仍有排队输入，需要回收会话');
        }
        if (await this.waitForIdle(session, jobId)) {
          return { aborted: true, settled: true, preservedSession: !session.dead, receipt: receipt || null };
        }
        throw new Error('中止后未收到轮次收尾事件');
      } catch (error) {
        // Defense in depth if a legacy caller bypassed the admission gate.
        // An old timeout/receipt must never kill a newer turn on this Query.
        if (superseded()) return finished();
        let closed;
        try { closed = this.killSession(session, '中止控制失败，回退回收'); }
        catch (_) {
          operation.hold = true;
          return { aborted: false, settled: false, preservedSession: false, message: '未能停止执行，请重试' };
        }
        return this._closed(operation, release, closed, error.message);
      }
    });
  }

  stopOneShot(child, jobId, conversationId) {
    return this._start(child, jobId, conversationId, (operation, release) => {
      let closed;
      try {
        const pending = child.kill('SIGTERM');
        closed = typeof child.whenClosed === 'function' ? child.whenClosed() : pending;
        if (!closed || typeof closed.then !== 'function') throw new Error('执行器无法确认停止');
      } catch (error) {
        operation.hold = true;
        return { aborted: false, settled: false, preservedSession: false, message: error.message };
      }
      return this._closed(operation, release, closed);
    });
  }
}

module.exports = { LiveTurnControls };
