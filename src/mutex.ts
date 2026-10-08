export type PromiseResolve<T> = (value: PromiseLike<T> | T) => void
export type PromiseReject = (reason?: any) => void
export type Task<T> = () => Promise<T>
export type Record<T> = [Task<T>, PromiseResolve<T>, PromiseReject]

export class Mutex<T> {
  private busy = false
  private readonly queue: Array<Record<T>> = []

  async dequeue() {
    this.busy = true
    const next = this.queue.shift()

    if (next) {
      return this.execute(next)
    }

    this.busy = false
  }

  async execute(record: Record<T>) {
    const [task, resolve, reject] = record

    // Use try/finally rather than task().then(resolve, reject).then(dequeue):
    // because dequeue/execute are async, a task that throws *synchronously*
    // would otherwise become a rejected promise that is discarded by the
    // `void this.dequeue()` callers, leaving the caller's promise forever
    // pending and the queue stalled (busy never resets). Awaiting the task
    // inside try funnels both synchronous throws and rejections to reject(),
    // and finally guarantees the queue keeps draining.
    try {
      resolve(await task())
    } catch (error) {
      reject(error)
    } finally {
      void this.dequeue()
    }
  }

  async synchronize(task: Task<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push([task, resolve, reject])
      if (!this.busy) {
        void this.dequeue()
      }
    })
  }
}
