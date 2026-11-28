import { localProfile } from './localProfile.js'

export const mobileClient = localProfile && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
export function requirePairing(response: Response) {
  if (mobileClient && response.status === 401 && response.headers.get('X-Becoming-Me-Pairing') === 'required') {
    window.location.replace('/mobile-connect')
  }
}
