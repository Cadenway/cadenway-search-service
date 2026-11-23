/** Gives other Search work time to proceed after an upstream read fails. */
export function nextSearchReadAttempt(): Date {
  return new Date(Date.now() + 30_000);
}
