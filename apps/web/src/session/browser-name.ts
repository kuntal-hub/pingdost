/** "Chrome on Windows": what the phone shows when it approves this browser, and later lists. */
export function browserName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Web browser';
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /CrOS/.test(userAgent)
      ? 'ChromeOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Mac OS X/.test(userAgent)
            ? 'macOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : undefined;
  return system ? `${browser} on ${system}` : browser;
}
