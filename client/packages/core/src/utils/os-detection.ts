export type DetectedOS =
  | 'macos'
  | 'windows'
  | 'linux'
  | 'ios'
  | 'android'
  | 'unknown';

/**
 * Detect the visitor's operating system from the user agent.
 *
 * Handles the iPad-as-macOS edge case: iPadOS 13+ reports a macOS user agent,
 * but we can distinguish it via touch support + maxTouchPoints.
 */
export function detectOS(): DetectedOS {
  if (typeof navigator === 'undefined') return 'unknown';

  const ua = navigator.userAgent;

  // Android check before macOS — some Android UAs contain "Linux"
  if (/android/i.test(ua)) return 'android';

  // iOS: iPhone, iPod
  if (/iPhone|iPod/.test(ua)) return 'ios';

  // macOS / iPad detection
  if (/Macintosh|Mac OS X/.test(ua)) {
    // iPadOS 13+ reports as macOS — detect via touch capabilities
    if ('ontouchend' in document && navigator.maxTouchPoints > 1) {
      return 'ios';
    }
    return 'macos';
  }

  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';

  return 'unknown';
}

/** Whether the detected OS is a mobile platform. */
export function isMobileOS(os?: DetectedOS): boolean {
  const detected = os ?? detectOS();
  return detected === 'ios' || detected === 'android';
}
