export const SUBMISSION_QUEUE_STATUS = Object.freeze({
  PENDING: 'pending',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  FAILED: 'failed'
})

const STORAGE_KEY = 'spandan-submission-queue-v1'
const DB_NAME = 'spandan-submission-queue'
const DB_VERSION = 1
const STORE_NAME = 'submissions'
const SNAPSHOT_ID = 'queue'
const EMPTY_SNAPSHOT = Object.freeze({ submissions: [], updatedAt: 0 })

function createSubmissionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `submission_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function cloneSubmission(submission) {
  return {
    ...submission,
    selectedAnswer: Array.isArray(submission.selectedAnswer)
      ? [...submission.selectedAnswer]
      : submission.selectedAnswer
  }
}

function normalizeRestoredSubmission(submission) {
  if (!submission?.submissionId) return null

  const status = submission.status === SUBMISSION_QUEUE_STATUS.SYNCING
    ? SUBMISSION_QUEUE_STATUS.PENDING
    : submission.status

  if (status !== SUBMISSION_QUEUE_STATUS.PENDING) return null

  return {
    submissionId: submission.submissionId,
    roomId: submission.roomId,
    questionId: submission.questionId,
    studentId: submission.studentId,
    selectedAnswer: Array.isArray(submission.selectedAnswer)
      ? [...submission.selectedAnswer]
      : submission.selectedAnswer,
    responseTime: submission.responseTime,
    clientSubmittedAt: submission.clientSubmittedAt,
    retryCount: Number.isInteger(submission.retryCount) ? submission.retryCount : 0,
    status
  }
}

function normalizeSnapshot(snapshot) {
  if (Array.isArray(snapshot)) {
    return {
      submissions: snapshot.map(normalizeRestoredSubmission).filter(Boolean),
      updatedAt: 0
    }
  }

  const submissions = Array.isArray(snapshot?.submissions)
    ? snapshot.submissions.map(normalizeRestoredSubmission).filter(Boolean)
    : []
  const updatedAt = Number.isFinite(snapshot?.updatedAt) ? snapshot.updatedAt : 0

  return { submissions, updatedAt }
}

function readLocalSnapshot(storage, storageKey) {
  try {
    const raw = storage?.getItem?.(storageKey)
    if (!raw) return EMPTY_SNAPSHOT

    const parsed = JSON.parse(raw)
    return normalizeSnapshot(parsed)
  } catch (error) {
    console.warn('Unable to restore queued submissions from localStorage:', error)
    return EMPTY_SNAPSHOT
  }
}

function writeLocalSnapshot(storage, storageKey, snapshot) {
  try {
    storage?.setItem?.(storageKey, JSON.stringify(snapshot))
  } catch (error) {
    console.warn('Unable to persist queued submissions to localStorage:', error)
  }
}

function openQueueDatabase(indexedDBRef) {
  if (!indexedDBRef) return Promise.resolve(null)

  return new Promise((resolve) => {
    const request = indexedDBRef.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

async function readIndexedSnapshot(indexedDBRef) {
  const db = await openQueueDatabase(indexedDBRef)
  if (!db) return null

  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(SNAPSHOT_ID)

    request.onsuccess = () => {
      resolve(request.result ? normalizeSnapshot(request.result) : null)
    }
    request.onerror = () => resolve(null)
    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

async function writeIndexedSnapshot(indexedDBRef, snapshot) {
  const db = await openQueueDatabase(indexedDBRef)
  if (!db) return

  await new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.put({ id: SNAPSHOT_ID, ...snapshot })

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      resolve()
    }
  })
}

export function createSubmissionQueue({
  persistent = false,
  storageKey = STORAGE_KEY,
  localStorageRef = globalThis.localStorage,
  indexedDBRef = globalThis.indexedDB
} = {}) {
  const localSnapshot = persistent ? readLocalSnapshot(localStorageRef, storageKey) : EMPTY_SNAPSHOT
  const queue = localSnapshot.submissions.map(cloneSubmission)
  let lastPersistedAt = localSnapshot.updatedAt
  const restoreListeners = new Set()

  function getPersistableSubmissions() {
    return queue
      .filter(item => item.status === SUBMISSION_QUEUE_STATUS.PENDING || item.status === SUBMISSION_QUEUE_STATUS.SYNCING)
      .map(item => ({
        ...cloneSubmission(item),
        status: item.status === SUBMISSION_QUEUE_STATUS.SYNCING
          ? SUBMISSION_QUEUE_STATUS.PENDING
          : item.status
      }))
  }

  function persistQueue() {
    if (!persistent) return

    const snapshot = {
      submissions: getPersistableSubmissions(),
      updatedAt: Date.now()
    }
    lastPersistedAt = snapshot.updatedAt

    writeLocalSnapshot(localStorageRef, storageKey, snapshot)
    writeIndexedSnapshot(indexedDBRef, snapshot).catch(error => {
      console.warn('Unable to persist queued submissions to IndexedDB:', error)
    })
  }

  function restoreIndexedSnapshot(snapshot) {
    if (!snapshot) return
    if (snapshot.updatedAt < lastPersistedAt) return

    queue.splice(0, queue.length)
    let added = false

    snapshot.submissions.forEach(submission => {
      queue.push(cloneSubmission(submission))
      added = true
    })

    lastPersistedAt = snapshot.updatedAt
    if (snapshot.updatedAt > localSnapshot.updatedAt) {
      writeLocalSnapshot(localStorageRef, storageKey, snapshot)
    }

    if (added || snapshot.updatedAt > localSnapshot.updatedAt) {
      restoreListeners.forEach(listener => listener())
    }
  }

  if (persistent) {
    readIndexedSnapshot(indexedDBRef)
      .then(restoreIndexedSnapshot)
      .catch(error => {
        console.warn('Unable to restore queued submissions from IndexedDB:', error)
      })
  }

  function findIndexBySubmissionId(submissionId) {
    return queue.findIndex(item => item.submissionId === submissionId)
  }

  return {
    enqueue(submission) {
      const queuedSubmission = {
        submissionId: submission.submissionId || createSubmissionId(),
        roomId: submission.roomId,
        questionId: submission.questionId,
        studentId: submission.studentId,
        selectedAnswer: Array.isArray(submission.selectedAnswer)
          ? [...submission.selectedAnswer]
          : submission.selectedAnswer,
        responseTime: submission.responseTime,
        clientSubmittedAt: submission.clientSubmittedAt || new Date().toISOString(),
        retryCount: Number.isInteger(submission.retryCount) ? submission.retryCount : 0,
        status: submission.status || SUBMISSION_QUEUE_STATUS.PENDING
      }

      queue.push(queuedSubmission)
      persistQueue()
      return cloneSubmission(queuedSubmission)
    },

    dequeue() {
      const nextSubmission = queue.find(item => item.status === SUBMISSION_QUEUE_STATUS.PENDING)
      if (!nextSubmission) return null

      nextSubmission.status = SUBMISSION_QUEUE_STATUS.SYNCING
      persistQueue()
      return cloneSubmission(nextSubmission)
    },

    getPending() {
      return queue
        .filter(item => item.status === SUBMISSION_QUEUE_STATUS.PENDING)
        .map(cloneSubmission)
    },

    markSynced(submissionId) {
      const index = findIndexBySubmissionId(submissionId)
      if (index === -1) return null

      const [syncedSubmission] = queue.splice(index, 1)
      syncedSubmission.status = SUBMISSION_QUEUE_STATUS.SYNCED
      persistQueue()
      return cloneSubmission(syncedSubmission)
    },

    markFailed(submissionId) {
      const index = findIndexBySubmissionId(submissionId)
      if (index === -1) return null

      queue[index].status = SUBMISSION_QUEUE_STATUS.FAILED
      queue[index].retryCount += 1
      persistQueue()
      return cloneSubmission(queue[index])
    },

    markPending(submissionId) {
      const index = findIndexBySubmissionId(submissionId)
      if (index === -1) return null

      queue[index].status = SUBMISSION_QUEUE_STATUS.PENDING
      queue[index].retryCount += 1
      persistQueue()
      return cloneSubmission(queue[index])
    },

    onRestore(listener) {
      restoreListeners.add(listener)
      return () => restoreListeners.delete(listener)
    }
  }
}

const submissionQueueService = createSubmissionQueue({ persistent: true })

export default submissionQueueService
