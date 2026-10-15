// Its message is printed verbatim, so it must never contain secrets.
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const API_KEY_ANYWHERE = /rpk_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/g
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

// Server-supplied text: drop control characters, mask key-shaped strings.
export const sanitizeForOutput = (value: unknown): string =>
  Array.from(String(value ?? '').replace(CONTROL_CHARACTERS, '').replace(API_KEY_ANYWHERE, '[redacted]'))
    .slice(0, 500)
    .join('')
