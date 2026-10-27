export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)(?!\[REDACTED\])\S+/g, '$1[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]');
}
