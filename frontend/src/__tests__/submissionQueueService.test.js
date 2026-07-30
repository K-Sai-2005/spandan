import {
  SUBMISSION_QUEUE_STATUS,
  createSubmissionQueue
} from '../services/submissionQueueService.js'

describe('submissionQueueService', () => {
  const baseSubmission = {
    roomId: 'room-1',
    questionId: 'question-1',
    studentId: 'student-1',
    selectedAnswer: [0],
    responseTime: 8,
    clientSubmittedAt: '2026-07-22T10:00:08.000Z'
  }

  it('enqueues a pending submission with required queue fields', () => {
    const queue = createSubmissionQueue()

    const queued = queue.enqueue(baseSubmission)

    expect(queued).toEqual(expect.objectContaining({
      roomId: baseSubmission.roomId,
      questionId: baseSubmission.questionId,
      studentId: baseSubmission.studentId,
      selectedAnswer: baseSubmission.selectedAnswer,
      responseTime: baseSubmission.responseTime,
      clientSubmittedAt: baseSubmission.clientSubmittedAt,
      retryCount: 0,
      status: SUBMISSION_QUEUE_STATUS.PENDING
    }))
    expect(queued.submissionId).toEqual(expect.any(String))
  })

  it('returns pending submissions without exposing mutable queue state', () => {
    const queue = createSubmissionQueue()
    const queued = queue.enqueue(baseSubmission)

    queued.selectedAnswer.push(1)
    const pending = queue.getPending()

    expect(pending).toHaveLength(1)
    expect(pending[0].selectedAnswer).toEqual([0])
  })

  it('dequeues the oldest pending submission into syncing state', () => {
    const queue = createSubmissionQueue()
    const first = queue.enqueue({ ...baseSubmission, questionId: 'question-1' })
    queue.enqueue({ ...baseSubmission, questionId: 'question-2' })

    const dequeued = queue.dequeue()

    expect(dequeued.submissionId).toBe(first.submissionId)
    expect(dequeued.status).toBe(SUBMISSION_QUEUE_STATUS.SYNCING)
    expect(queue.getPending()).toHaveLength(1)
  })

  it('marks synced submissions and removes them from the pending queue', () => {
    const queue = createSubmissionQueue()
    const synced = queue.enqueue(baseSubmission)

    const syncedSubmission = queue.markSynced(synced.submissionId)

    expect(syncedSubmission.status).toBe(SUBMISSION_QUEUE_STATUS.SYNCED)
    expect(queue.getPending()).toHaveLength(0)
  })

  it('marks failed submissions and increments retry count', () => {
    const queue = createSubmissionQueue()
    const failed = queue.enqueue({ ...baseSubmission, questionId: 'question-2' })

    const failedSubmission = queue.markFailed(failed.submissionId)
    expect(failedSubmission.status).toBe(SUBMISSION_QUEUE_STATUS.FAILED)
    expect(failedSubmission.retryCount).toBe(1)
  })

  it('returns retryable failures to pending status', () => {
    const queue = createSubmissionQueue()
    const queued = queue.enqueue(baseSubmission)
    queue.dequeue()

    const pendingSubmission = queue.markPending(queued.submissionId)

    expect(pendingSubmission.status).toBe(SUBMISSION_QUEUE_STATUS.PENDING)
    expect(pendingSubmission.retryCount).toBe(1)
    expect(queue.getPending()).toHaveLength(1)
  })

  it('restores pending submissions from persistent storage', () => {
    const storage = new Map()
    const localStorageRef = {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    }
    const storageKey = 'test-submission-queue'

    const firstQueue = createSubmissionQueue({
      persistent: true,
      storageKey,
      localStorageRef,
      indexedDBRef: null
    })
    firstQueue.enqueue(baseSubmission)

    const restoredQueue = createSubmissionQueue({
      persistent: true,
      storageKey,
      localStorageRef,
      indexedDBRef: null
    })

    expect(restoredQueue.getPending()).toEqual([
      expect.objectContaining({
        roomId: baseSubmission.roomId,
        questionId: baseSubmission.questionId,
        studentId: baseSubmission.studentId,
        selectedAnswer: baseSubmission.selectedAnswer,
        responseTime: baseSubmission.responseTime,
        clientSubmittedAt: baseSubmission.clientSubmittedAt,
        status: SUBMISSION_QUEUE_STATUS.PENDING
      })
    ])
  })

  it('restores in-flight syncing submissions as pending after refresh', () => {
    const storage = new Map()
    const localStorageRef = {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    }
    const storageKey = 'test-submission-queue-syncing'

    const firstQueue = createSubmissionQueue({
      persistent: true,
      storageKey,
      localStorageRef,
      indexedDBRef: null
    })
    firstQueue.enqueue(baseSubmission)
    firstQueue.dequeue()

    const restoredQueue = createSubmissionQueue({
      persistent: true,
      storageKey,
      localStorageRef,
      indexedDBRef: null
    })

    expect(restoredQueue.getPending()).toEqual([
      expect.objectContaining({
        questionId: baseSubmission.questionId,
        status: SUBMISSION_QUEUE_STATUS.PENDING
      })
    ])
  })
})
