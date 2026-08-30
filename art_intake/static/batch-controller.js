const transientStatus = status => status === 0 || status === 429 || status >= 500;

export class BatchController {
  constructor({ runTask, onUpdate = () => {}, delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), retryDelays = [1000, 3000, 8000] }) {
    this.runTask = runTask;
    this.onUpdate = onUpdate;
    this.delay = delay;
    this.retryDelays = retryDelays;
    this.reset();
  }

  reset() {
    this.state = { status: 'idle', total: 0, completed: [], failed: [], current: null, remaining: [] };
    this._resume = null;
    this._cancelled = false;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  _emit() { this.onUpdate(this.snapshot()); }

  async start(items) {
    if (this.state.status === 'running' || this.state.status === 'paused') throw new Error('A batch is already active.');
    this.state = { status: 'running', total: items.length, completed: [], failed: [], current: null, remaining: [...items] };
    this._cancelled = false;
    this._emit();
    while (this.state.remaining.length && !this._cancelled) {
      if (this.state.status === 'paused') await new Promise(resolve => { this._resume = resolve; });
      if (this._cancelled) break;
      const item = this.state.remaining[0];
      this.state.current = item;
      this._emit();
      try {
        const result = await this._runWithRetry(item);
        this.state.completed.push({ item, result });
      } catch (error) {
        this.state.failed.push({ item, message: error.message, status: Number(error.status) || 0 });
      }
      this.state.remaining.shift();
      this.state.current = null;
      this._emit();
    }
    this.state.status = this._cancelled ? 'cancelled' : 'complete';
    this.state.current = null;
    this._emit();
    return this.snapshot();
  }

  async _runWithRetry(item) {
    let attempt = 0;
    while (true) {
      try { return await this.runTask(item, attempt + 1); }
      catch (error) {
        if (!transientStatus(Number(error.status) || 0) || attempt >= this.retryDelays.length) throw error;
        await this.delay(this.retryDelays[attempt]);
        attempt += 1;
      }
    }
  }

  pause() {
    if (this.state.status === 'running') { this.state.status = 'paused'; this._emit(); }
  }

  resume() {
    if (this.state.status !== 'paused') return;
    this.state.status = 'running';
    const resume = this._resume;
    this._resume = null;
    this._emit();
    resume?.();
  }

  cancel() {
    if (!['running', 'paused'].includes(this.state.status)) return;
    this._cancelled = true;
    const resume = this._resume;
    this._resume = null;
    resume?.();
  }
}
