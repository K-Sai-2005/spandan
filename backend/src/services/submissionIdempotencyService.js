import { createClient } from 'redis'
import { config } from '../config.js'

const KEY_PREFIX = 'submission:idempotency:'

let redisClient = null
let connectPromise = null

function getTtlSeconds() {
  return Number.isInteger(config.submissionIdempotencyTtlSeconds) && config.submissionIdempotencyTtlSeconds > 0
    ? config.submissionIdempotencyTtlSeconds
    : 86400
}

function getRedisClient() {
  if (!config.redisUrl) return null

  if (!redisClient) {
    redisClient = createClient({ url: config.redisUrl })
    redisClient.on('error', error => {
      console.warn('[submissionIdempotency] Redis error:', error.message)
    })
  }

  return redisClient
}

async function ensureConnected() {
  const client = getRedisClient()
  if (!client) return null
  if (client.isOpen) return client

  if (!connectPromise) {
    connectPromise = client.connect().catch(error => {
      console.warn('[submissionIdempotency] Redis connection failed:', error.message)
      return null
    }).finally(() => {
      connectPromise = null
    })
  }

  await connectPromise
  return client.isOpen ? client : null
}

export function createSubmissionIdempotencyKey(submissionId) {
  return `${KEY_PREFIX}${submissionId}`
}

export function sanitizeSubmissionId(submissionId) {
  if (typeof submissionId !== 'string') return ''
  return submissionId.trim().slice(0, 128)
}

export function createAcknowledgementPayload(response) {
  return {
    success: true,
    response
  }
}

export async function getProcessedSubmission(submissionId) {
  const normalizedSubmissionId = sanitizeSubmissionId(submissionId)
  if (!normalizedSubmissionId) return null

  const client = await ensureConnected()
  if (!client) return null

  try {
    const raw = await client.get(createSubmissionIdempotencyKey(normalizedSubmissionId))
    return raw ? JSON.parse(raw) : null
  } catch (error) {
    console.warn('[submissionIdempotency] Redis read failed:', error.message)
    return null
  }
}

export async function storeProcessedSubmission(submissionId, payload) {
  const normalizedSubmissionId = sanitizeSubmissionId(submissionId)
  if (!normalizedSubmissionId) return

  const client = await ensureConnected()
  if (!client) return

  try {
    await client.set(createSubmissionIdempotencyKey(normalizedSubmissionId), JSON.stringify(payload), {
      EX: getTtlSeconds()
    })
  } catch (error) {
    console.warn('[submissionIdempotency] Redis write failed:', error.message)
  }
}

export async function closeSubmissionIdempotencyClient() {
  if (!redisClient?.isOpen) return
  await redisClient.quit()
}
