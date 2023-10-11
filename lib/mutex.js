"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Mutex = void 0;
class Mutex {
    constructor() {
        this.busy = false;
        this.queue = [];
    }
    synchronize(task) {
        return new Promise((resolve, reject) => {
            this.queue.push([task, resolve, reject]);
            if (!this.busy) {
                this.dequeue();
            }
        });
    }
    dequeue() {
        this.busy = true;
        const next = this.queue.shift();
        if (next) {
            return this.execute(next);
        }
        this.busy = false;
    }
    execute(record) {
        const [task, resolve, reject] = record;
        return task()
            .then(resolve, reject)
            .then(() => {
            this.dequeue();
        });
    }
}
exports.Mutex = Mutex;
