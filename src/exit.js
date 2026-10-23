/** Коды выхода — единые для всех команд, чтобы оркестратор ветвился по ним без разбора текста. */
export const EXIT = {
  ok: 0,
  error: 1,
  timeout: 2,
  waiting: 3,
  idle: 4,
  apiError: 5,
  gone: 6,
  notAccepted: 7,
  limit: 8,
  check: 9,
}
