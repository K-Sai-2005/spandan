import { createSubmissionQueue } from '../services/submissionQueueService.js'
import {
  SUBMISSION_RETRY_POLICY,
  SubmissionRetryError,
  calculateDelay,
  bindSubmissionRetryTriggers,
  MANUAL_RECONNECT_EVENT,
  createSubmissionRetryWorker
} from '../services/submissionRetryWorker.js'

describe('submissionRetryWorker', () => {
  const submission = {
    roomId: 'room-1',
    questionId: 'question-1',
    studentId: 'student-1',
    selectedAnswer: [0],
    responseTime: 8,
    clientSubmittedAt: '2026-07-22T10:00:08.000Z'
  }

  function createManualTimers() {
    const scheduled = []

    return {
      scheduled,
      setTimeout: (callback, delay) => {
        scheduled.push({ callback, delay })
        return scheduled.length
      },
      clearTimeout: jest.fn()
    }
  }

  it('syncs pending submissions and removes them from the queue', async () => {
    const queue = createSubmissionQueue()
    queue.enqueue(submission)
    const submit = jest.fn().mockResolvedValue({ success: true })
    const onSynced = jest.fn()

    const worker = createSubmissionRetryWorker({ queue, submit, onSynced })
    await worker.run()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(queue.getPending()).toHaveLength(0)
    expect(onSynced).toHaveBeenCalledTimes(1)
  })

  it('keeps retryable network failures pending for a later retry', async () => {
    const queue = createSubmissionQueue()
    queue.enqueue(submission)
    const timers = createManualTimers()
    const submit = jest.fn().mockRejectedValue(new SubmissionRetryError('offline', {
      retryable: true
    }))

    const worker = createSubmissionRetryWorker({ queue, submit, timers, random: () => 0.5 })
    await worker.run()

    const pending = queue.getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].retryCount).toBe(1)
    expect(timers.scheduled[0].delay).toBe(1000)
  })

  it('does not retry validation or duplicate response failures', async () => {
    const queue = createSubmissionQueue()
    queue.enqueue(submission)
    const timers = createManualTimers()
    const submit = jest.fn().mockRejectedValue(new SubmissionRetryError('Already responded', {
      retryable: false,
      status: 409
    }))
    const onFailed = jest.fn()

    const worker = createSubmissionRetryWorker({ queue, submit, onFailed, timers })
    await worker.run()

    expect(queue.getPending()).toHaveLength(0)
    expect(timers.scheduled).toHaveLength(0)
    expect(onFailed).toHaveBeenCalledTimes(1)
  })

  it('stops retrying after the maximum retry attempts', async () => {
    const queue = createSubmissionQueue()
    queue.enqueue({ ...submission, retryCount: 4 })
    const timers = createManualTimers()
    const submit = jest.fn().mockRejectedValue(new SubmissionRetryError('server unavailable', {
      retryable: true,
      status: 503
    }))
    const onFailed = jest.fn()

    const worker = createSubmissionRetryWorker({ queue, submit, onFailed, timers })
    await worker.run()

    expect(queue.getPending()).toHaveLength(0)
    expect(timers.scheduled).toHaveLength(0)
    expect(onFailed).toHaveBeenCalledTimes(1)
  })

  it('caps exponential backoff and applies jitter', () => {
    const policy = {
      ...SUBMISSION_RETRY_POLICY,
      initialDelayMs: 1000,
      backoffFactor: 2,
      jitterRatio: 0.1,
      maxRetryIntervalMs: 5000
    }

    expect(calculateDelay(1, policy, () => 0.5)).toBe(1000)
    expect(calculateDelay(10, policy, () => 0.5)).toBe(5000)
    expect(calculateDelay(10, policy, () => 1)).toBe(5500)
  })

  it('flushes the worker for browser, socket, and manual reconnect signals', () => {
    const listeners = new Map()
    const eventTarget = {
      addEventListener: jest.fn((event, listener) => listeners.set(event, listener)),
      removeEventListener: jest.fn((event) => listeners.delete(event))
    }
    const socket = {
      io: {
        on: jest.fn(),
        off: jest.fn()
      },
      on: jest.fn(),
      off: jest.fn()
    }
    const worker = { flushNow: jest.fn() }

    const unsubscribe = bindSubmissionRetryTriggers({ worker, socket, eventTarget })

    listeners.get('online')()
    listeners.get(MANUAL_RECONNECT_EVENT)()
    socket.on.mock.calls.find(([event]) => event === 'connect')[1]()
    socket.on.mock.calls.find(([event]) => event === 'reconnect')[1]()
    socket.io.on.mock.calls.find(([event]) => event === 'reconnect')[1]()

    expect(worker.flushNow).toHaveBeenCalledTimes(5)

    unsubscribe()
    expect(eventTarget.removeEventListener).toHaveBeenCalledTimes(2)
    expect(socket.off).toHaveBeenCalledTimes(2)
    expect(socket.io.off).toHaveBeenCalledTimes(1)
  })
})
