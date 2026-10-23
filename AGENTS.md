# agent — шпаргалка для агентов и оркестраторов

CLI для рутины вокруг Claude Code в Superset: сессии, pen.dev, коммит по плану, worktree-слоты.
Подробности, схема плана и ограничения — [README.md](README.md).

## Вызов

`agent …` после `npm link` (делает человек) или `node ~/VScodeProjects/agent-cli/bin/agent.js …`.
У всех команд `--json`; ошибки — `Ошибка: …` в stderr (с `--json` — `{error, code}` в stdout).
**`git push` CLI не делает никогда.** Не переписывай CLI под задачу — сообщи человеку.

## Сессии Claude

```sh
agent sess ls                                    # терминал, алиас, состояние, RSS, session id; «N из 5»
agent sess create --workspace <id|имя> --prompt-file task.md --model opus --effort high --alias task-x
A=$(agent sess send task-x --file msg.md --json | jq -r .anchor)   # ждёт, пока сообщение попадёт в журнал
agent sess wait task-x --marker DONE-X --after "$A" --timeout 1800  # маркер = [[DONE-X]] в ответе после якоря
agent sess last task-x                           # последний ответ ассистента целиком
agent sess close task-x --note "ждёт ревью"      # в реестр; закрывает панель, пустые шеллы и мёртвые панели воркспейса
agent sess resume task-x                         # снова открыть ту же сессию (claude --resume)
agent sess keep task-x                           # gc эту сессию не закроет (снять: --rm task-x)
agent sess gc                                    # план уборки проекта; --apply — закрыть
```

- Терминал — полный id, префикс от 6 символов или алиас (`agent sess alias <имя> <терм>`).
- `wait` читает журнал Claude, а не экран; печатает последний ответ и причину выхода.
- `send` в сессию, ждущую разрешения, и `close` работающей — только с `--force`.
- `send` укладывается в `--timeout` (20 с); код 7 — подтверждения нет, но сообщение могло дойти:
  не шли повторно, смотри `sess last` или `sess wait` без `--after`.
- `gc` (по умолчанию — только текущий проект, иначе `--project a,b`) закрывает idle-сессии с
  `[[DONE…]]` в последнем ответе или без активности дольше `--idle` (30m), завершившиеся терминалы,
  пустые шеллы, панели без терминала; освобождает слоты; закрывает ненужный Pen (`--keep-pen` — нет).
  Не трогает работающие, ждущие ответа, с вопросом в последнем ответе, keep и текущую сессию.

## pen.dev

```sh
agent pen ls                                     # окна и пути файлов
agent pen save design/x/screen.pen               # File › Save + проверка mtime (⌘S не работает)
agent pen save-all
agent pen restart                                # сохранить всё, выйти, открыть те же файлы
agent pen save screen.pen --dry-run              # показать AppleScript, ничего не нажимать
agent pen quit                                   # save-all и выход; код 9, если файл нужен живой сессии
agent pen idle-check --apply                     # закрыть Pen, если он не нужен ни одной сессии
```

Нужен «Универсальный доступ» для Superset/Terminal (иначе -1719 и подсказка). `verified: false` —
mtime не изменился: несохранённых правок не было или файл окна неизвестен.

## Коммит по плану

```sh
agent commit hunks README.md                     # номера ханков для include
agent commit plan.json                           # сухой прогон: индекс и HEAD не меняются
agent commit plan.json --apply                   # только по отмашке человека
```

```json
[
  { "message": "feat(task): …\n\nтело\n\nCo-Authored-By: …", "paths": ["src/a.js", "docs/a.md"],
    "hunks": [{ "path": "README.md", "include": [1, 3] }] },
  { "closeChange": "task" }
]
```

`paths` — только файлы, целиком (каталог — отказ: захватил бы чужие правки); `hunks.include` — номера
ханков или строка-маркер; `closeChange` — `closeCommand` проекта и коммит закрытия. Индекс до начала пуст; в коммите ровно заявленное; запрещённые
пути и шаблон сообщения — из `.agent-cli.json` репозитория.

## Слоты

```sh
agent slot ls --project sellerai                 # имя, ветка, чисто/грязно, влита ли в main, живые сессии
agent slot prepare slot-3 --branch new-task --task store-delivery   # от main; имя → «slot-3 · store-delivery»
agent slot prepare <слот> --branch new-task --carry   # бэкап и перенос правок на новую ветку
agent slot release slot-3                        # имя → «slot-3»: сессий нет, ветка влита или задача закрыта
```

Слот — воркспейс с именем «slot-N…» (папка worktree может называться иначе). Грязный слот → бэкап и
стоп (код 9). Слот с живой сессией и основную копию проекта не переключает.

## Коды выхода

0 ок · 1 ошибка · 2 таймаут · 3 ждёт разрешения/ответа · 4 ход закончен без маркера · 5 ошибка API ·
6 сессии нет · 7 нет подтверждения приёма · 8 лимит сессий · 9 проверка не пройдена.
