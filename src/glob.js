/**
 * Glob → RegExp для путей относительно корня репозитория: `**` — любое число каталогов, `*` и `?` —
 * внутри одного сегмента. Шаблон без `/` сравнивается с именем файла в любом каталоге (как в .gitignore).
 */
export const globToRegExp = (glob) => {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const anchored = glob.includes('/') ? `^${source}$` : `(?:^|/)${source}$`
  return new RegExp(anchored)
}

export const matchesAny = (path, globs) => globs.some((glob) => globToRegExp(glob).test(path))
