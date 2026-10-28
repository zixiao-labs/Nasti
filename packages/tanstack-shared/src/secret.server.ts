// The sentinel must not be emitted into client JavaScript.
const secret = 'NASTI_SERVER_SECRET_SENTINEL'
export function serverValue() {
  return secret.length > 0 ? 'SSR_OK' : 'unavailable'
}
