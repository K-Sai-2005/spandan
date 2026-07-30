const TIMING_SKEW_TOLERANCE_MS = 1500

function parseDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function validateResponseTiming({
  question,
  responseTime,
  clientSubmittedAt,
  receivedAt = new Date()
}) {
  const timeToAnswerSeconds = question?.timeToAnswer || 30
  const publishTime = parseDate(question?.publishTime)
  const expiresAt = parseDate(question?.expiresAt)
  const receivedTime = parseDate(receivedAt)
  const submittedAt = parseDate(clientSubmittedAt) || receivedTime

  if (!publishTime || !expiresAt) {
    return {
      valid: false,
      status: 409,
      error: 'Question timing window is not available'
    }
  }

  if (!isFiniteNumber(responseTime)) {
    return {
      valid: false,
      status: 400,
      error: 'Invalid responseTime'
    }
  }

  if (responseTime < 0) {
    return {
      valid: false,
      status: 400,
      error: 'Negative response times are not allowed'
    }
  }

  if (!submittedAt) {
    return {
      valid: false,
      status: 400,
      error: 'Invalid clientSubmittedAt timestamp'
    }
  }

  if (expiresAt.getTime() <= publishTime.getTime()) {
    return {
      valid: false,
      status: 409,
      error: 'Question timing window is invalid'
    }
  }

  if (submittedAt.getTime() < publishTime.getTime() - TIMING_SKEW_TOLERANCE_MS) {
    return {
      valid: false,
      status: 400,
      error: 'clientSubmittedAt is before the question was published'
    }
  }

  if (submittedAt.getTime() > expiresAt.getTime() + TIMING_SKEW_TOLERANCE_MS) {
    return {
      valid: false,
      status: 409,
      error: 'Answer was submitted after the question expired'
    }
  }

  const maxResponseTimeMs = timeToAnswerSeconds * 1000
  const responseTimeMs = responseTime * 1000

  if (responseTimeMs > maxResponseTimeMs + TIMING_SKEW_TOLERANCE_MS) {
    return {
      valid: false,
      status: 400,
      error: 'responseTime exceeds the question time limit'
    }
  }

  const elapsedFromPublishMs = submittedAt.getTime() - publishTime.getTime()
  if (responseTimeMs > elapsedFromPublishMs + TIMING_SKEW_TOLERANCE_MS) {
    return {
      valid: false,
      status: 400,
      error: 'responseTime is impossible for the submitted timestamp'
    }
  }

  return {
    valid: true,
    recordedAt: submittedAt,
    publishTime,
    expiresAt
  }
}
