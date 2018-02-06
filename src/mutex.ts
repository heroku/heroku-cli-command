export type PromiseResolve<T> = (value: T | PromiseLike<T> | undefined) => void
export type PromiseReject = (reason?: any) => void
export type Task<T> = () => Promise<T>
export type Record<T> = [Task<T>, PromiseResolve<T>, PromiseReject]

export class Mutex<T> {
  private busy = false
  private readonly queue: Array<Record<T>> = []

  synchronize(task: Task<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push([task, resolve, reject])
      if (!this.busy) {
        this.dequeue()
      }
    })
  }

  dequeue() {
    this.busy = true
    let next = this.queue.shift()

    if (next) {
      this.execute(next)
    } else {
      this.busy = false
    }
  }

  execute(record: Record<T>) {
    let [task, resolve, reject] = record

    task()
      .then(resolve, reject)
      .then(() => {
        this.dequeue()
      })
  }
}
