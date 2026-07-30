import submissionQueueService from './submissionQueueService.js'

export const MANUAL_RECONNECT_EVENT = 'spandan:manual-reconnect'

export const SUBMISSION_RETRY_POLICY = Object.freeze({
  initialDelayMs: 1000,
  backoffFactor: 2,
  jitterRatio: 0.3,
  maxRetryIntervalMs: 30000,
  maxRetryAttempts: 5
})

export class SubmissionRetryError extends Error {
  constructor(message, { retryable = false, status = null, response = null } = {}) {
    super(message)
    this.name = 'SubmissionRetryError'
    this.retryable = retryable
    this.status = status
    this.response = response
  }
}

function calculateDelay(retryCount, policy, random = Math.random) {
  const retryExponent = Math.max(0, retryCount - 1)
  const exponentialDelay = policy.initialDelayMs * (policy.backoffFactor ** retryExponent)
  const cappedDelay = Math.min(exponentialDelay, policy.maxRetryIntervalMs)
  const jitterWindow = cappedDelay * policy.jitterRatio
  const jitter = (random() * jitterWindow * 2) - jitterWindow

  return Math.max(0, Math.round(cappedDelay + jitter))
}

export function createSubmissionRetryWorker({
  queue = submissionQueueService,
  submit,
  onSynced = () => {},
  onFailed = () => {},
  policy = SUBMISSION_RETRY_POLICY,
  timers = globalThis,
  random = Math.random
} = {}) {
  let timerId = null
  let running = false
  const unsubscribeRestore = queue.onRestore?.(() => schedule())

  function clearScheduledRetry() {
    if (timerId !== null) {
      timers.clearTimeout(timerId)
      timerId = null
    }
  }

  function getNextDelay() {
    const [nextSubmission] = queue.getPending()
    if (!nextSubmission) return null
    return calculateDelay(nextSubmission.retryCount, policy, random)
  }

  function schedule() {
    if (timerId !== null || running) return

    const delay = getNextDelay()
    if (delay === null) return

    timerId = timers.setTimeout(() => {
      timerId = null
      run()
    }, delay)
  }

  async function run() {
    if (running) return
    running = true

    try {
      let submission = queue.dequeue()

      while (submission) {
        try {
          const result = await submit(submission)
          const syncedSubmission = queue.markSynced(submission.submissionId)
          onSynced(syncedSubmission || submission, result)
        } catch (error) {
          if (!error?.retryable) {
            const failedSubmission = queue.markFailed(submission.submissionId)
            onFailed(failedSubmission || submission, error)
          } else if (submission.retryCount + 1 >= policy.maxRetryAttempts) {
            const failedSubmission = queue.markFailed(submission.submissionId)
            onFailed(failedSubmission || submission, error)
          } else {
            queue.markPending(submission.submissionId)
          }

          break
        }

        submission = queue.dequeue()
      }
    } finally {
      running = false
      schedule()
    }
  }

  return {
    schedule,
    flushNow: () => {
      clearScheduledRetry()
      return run()
    },
    run,
    stop: () => {
      clearScheduledRetry()
      unsubscribeRestore?.()
    }
  }
}

// Registers connectivity signals with the one retry worker used by the page.
// This deliberately only triggers flushNow(); retry policy and queue handling
// remain in createSubmissionRetryWorker.
export function bindSubmissionRetryTriggers({
  worker,
  socket,
  eventTarget = globalThis
} = {}) {
  if (!worker) return () => {}

  const flushPendingSubmissions = () => worker.flushNow()
  const manager = socket?.io

  eventTarget?.addEventListener?.('online', flushPendingSubmissions)
  eventTarget?.addEventListener?.(MANUAL_RECONNECT_EVENT, flushPendingSubmissions)
  socket?.on?.('connect', flushPendingSubmissions)
  socket?.on?.('reconnect', flushPendingSubmissions)
  manager?.on?.('reconnect', flushPendingSubmissions)

  return () => {
    eventTarget?.removeEventListener?.('online', flushPendingSubmissions)
    eventTarget?.removeEventListener?.(MANUAL_RECONNECT_EVENT, flushPendingSubmissions)
    socket?.off?.('connect', flushPendingSubmissions)
    socket?.off?.('reconnect', flushPendingSubmissions)
    manager?.off?.('reconnect', flushPendingSubmissions)
  }
}

export { calculateDelay }
