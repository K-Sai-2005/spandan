import { validateResponseTiming } from '../services/responseTimingValidationService.js'

describe('responseTimingValidationService', () => {
  const publishTime = new Date('2026-07-22T10:00:00.000Z')
  const expiresAt = new Date('2026-07-22T10:00:30.000Z')
  const question = {
    publishTime,
    expiresAt,
    timeToAnswer: 30
  }

  it('accepts answers recorded before expiry even if uploaded later', () => {
    const result = validateResponseTiming({
      question,
      responseTime: 25,
      clientSubmittedAt: '2026-07-22T10:00:25.000Z',
      receivedAt: '2026-07-22T10:05:00.000Z'
    })

    expect(result.valid).toBe(true)
  })

  it('rejects negative response times', () => {
    const result = validateResponseTiming({
      question,
      responseTime: -1,
      clientSubmittedAt: '2026-07-22T10:00:05.000Z'
    })

    expect(result.valid).toBe(false)
    expect(result.error).toBe('Negative response times are not allowed')
  })

  it('rejects answers recorded after expiry', () => {
    const result = validateResponseTiming({
      question,
      responseTime: 31,
      clientSubmittedAt: '2026-07-22T10:00:31.700Z'
    })

    expect(result.valid).toBe(false)
    expect(result.error).toBe('Answer was submitted after the question expired')
  })

  it('rejects impossible client timestamps before publish', () => {
    const result = validateResponseTiming({
      question,
      responseTime: 2,
      clientSubmittedAt: '2026-07-22T09:59:57.000Z'
    })

    expect(result.valid).toBe(false)
    expect(result.error).toBe('clientSubmittedAt is before the question was published')
  })

  it('rejects response times that exceed elapsed time since publish', () => {
    const result = validateResponseTiming({
      question,
      responseTime: 20,
      clientSubmittedAt: '2026-07-22T10:00:05.000Z'
    })

    expect(result.valid).toBe(false)
    expect(result.error).toBe('responseTime is impossible for the submitted timestamp')
  })

  it('rejects missing publish or expiry timing windows', () => {
    const result = validateResponseTiming({
      question: { timeToAnswer: 30 },
      responseTime: 5,
      clientSubmittedAt: '2026-07-22T10:00:05.000Z'
    })

    expect(result.valid).toBe(false)
    expect(result.error).toBe('Question timing window is not available')
  })
})
