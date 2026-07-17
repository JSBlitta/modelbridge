const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const
type Level = keyof typeof LEVELS

let _level: number = LEVELS.info

export function initLogger(level?: string) {
  const lvl = (level || process.env.LOG_LEVEL || 'info').toLowerCase()
  if (lvl in LEVELS) _level = LEVELS[lvl as Level]
}

export const logger = {
  error: (...args: unknown[]) => { if (_level >= LEVELS.error) console.error(...args) },
  warn:  (...args: unknown[]) => { if (_level >= LEVELS.warn)  console.warn(...args) },
  info:  (...args: unknown[]) => { if (_level >= LEVELS.info)  console.info(...args) },
  debug: (...args: unknown[]) => { if (_level >= LEVELS.debug) console.debug(...args) },
}
