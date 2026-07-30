import {
  createAcknowledgementPayload,
  createSubmissionIdempotencyKey,
  getProcessedSubmission,
  sanitizeSubmissionId,
  storeProcessedSubmission
} from '../services/submissionIdempotencyService.js'

describe('submissionIdempotencyService', () => {
  it('normalizes submission IDs for Redis keys', () => {
    expect(sanitizeSubmissionId('  submission-123  ')).toBe('submission-123')
    expect(sanitizeSubmissionId(null)).toBe('')
    expect(sanitizeSubmissionId('x'.repeat(200))).toHaveLength(128)
    expect(createSubmissionIdempotencyKey('submission-123')).toBe('submission:idempotency:submission-123')
  })

  it('builds the acknowledgement payload returned for duplicate submissions', () => {
    const response = {
      submissionId: 'submission-123',
      points: 100,
      isCorrect: true
    }

    expect(createAcknowledgementPayload(response)).toEqual({
      success: true,
      response
    })
  })

  it('is a no-op when Redis is not configured', async () => {
    await expect(storeProcessedSubmission('submission-123', { success: true })).resolves.toBeUndefined()
    await expect(getProcessedSubmission('submission-123')).resolves.toBeNull()
  })
})
