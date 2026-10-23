# agent — CLI оркестратора и агентов

`agent` убирает ручную рутину вокруг сессий Claude Code в [Superset](https://docs.superset.sh/cli),
pen.dev, коммитов и worktree-слотов: каждая операция — одна команда с проверками, `--json` и
понятными кодами выхода вместо чтения экрана терминала.

- `agent sess` — сессии Claude: список, создание, отправка с подтверждением, ожидание маркера **по журналу**,
  закрытие с сохранением и `resume`, алиасы.
- `agent pen` — окна pen.dev: сохранение через меню File › Save с проверкой mtime, перезапуск.
- `agent commit` — коммиты по плану JSON: сухой прогон на временном индексе, затем `--apply`.
- `agent slot` — worktree-слоты проекта: состояние, подготовка под новую ветку с бэкапом.

Чистый Node.js 22+ (ESM), без зависимостей и сборки. `git push` CLI не делает никогда.
Краткая шпаргалка для агентов и ботов-оркестраторов — [AGENTS.md](AGENTS.md).

## Установка

```sh
cd ~/VScodeProjects/agent-cli
npm link            # появится глобальная команда `agent` (делает человек)
agent --help
```

Без `npm link` — `node ~/VScodeProjects/agent-cli/bin/agent.js …`. Удалить: `npm unlink -g agent-cli`.

## Команды

| Команда | Что делает |
| --- | --- |
| `agent sess ls [--json]` | все Claude-сессии Мака: терминал, алиас, состояние, RSS, проект/воркспейс, заголовок, session id; «N из лимита» |
| `agent sess create --workspace W --prompt-file F [--model M] [--effort E] [--alias A] [--force]` | новая сессия в воркспейсе (id, имя или префикс); возвращает терминал и Claude session id; отказ при лимите |
| `agent sess send <терм\|алиас> --file F \| --text T [--timeout 20] [--force]` | отправить и нажать Enter; ждёт, пока сообщение появится в журнале (весь срок — `--timeout`, по умолчанию `sendAcceptTimeoutSec`); печатает **якорь** — uuid записи |
| `agent sess wait <терм\|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]` | ждать `[[NAME]]` в ответе ассистента после якоря; печатает последний ответ целиком |
| `agent sess last <терм\|алиас>` | последний ответ ассистента целиком |
| `agent sess close <терм\|алиас> [--note T] [--force]` | сохранить session id, воркспейс, cwd, заметку в реестр и закрыть сессию через её панель (`panes close`); затем пустые шеллы и панели без терминала того же воркспейса; работающую — только с `--force`; ждёт выхода процесса до 10 с |
| `agent sess resume <session-id\|алиас> [--workspace W] [--prompt-file F]` | открыть сессию заново (`superset agents create --resume-session`) |
| `agent sess alias [<имя> <терм>] [--rm имя]` · `agent sess forget <id\|алиас>` | алиасы «задача → терминал»; удалить запись реестра |
| `agent sess keep [<терм\|алиас\|id>]` · `agent sess keep --rm <…>` | пометка keep: `gc` эту сессию не закрывает |
| `agent sess gc [--project P[,P2]] [--idle 30m] [--done REGEX] [--keep-pen] [--apply]` | уборка: законченные сессии, завершившиеся терминалы, пустые шеллы, панели без терминала, освобождение слотов, Pen без пользователей; без `--apply` — только план |
| `agent pen ls` | открытые окна Pen и их файлы |
| `agent pen save <файл\|окно>` · `save-all` | AXRaise окна + меню File › Save; проверка, что mtime файла изменился |
| `agent pen open <файл…>` · `close <окно>` | `open -a Pen`; меню File › Close Window |
| `agent pen restart [--open F]…` | сохранить все окна, `quit`, дождаться выхода, открыть файлы (по умолчанию — те же) |
| `agent pen quit [--force] [--dry-run]` | save-all с проверкой mtime и выход; отказ (код 9), если файл нужен живой сессии |
| `agent pen idle-check [--apply] [--recent 30m]` | закрыть Pen, если он не нужен ни одной живой сессии (это вызывает `gc`) |
| `agent commit <план.json> [--apply]` | коммиты по плану; без `--apply` — сухой прогон |
| `agent commit hunks <путь…>` | пронумерованные ханки неиндексированных изменений — для `include` |
| `agent slot ls [--project P]` | слоты: имя, ветка, чисто/грязно, влита ли ветка в main, есть ли живая сессия |
| `agent slot prepare <слот> --branch B [--task T] [--from main] [--carry] [--project P] [--force]` | новая ветка в слоте, хуки подготовки, имя «slot-N · T» (по умолчанию T — ветка) |
| `agent slot release <слот> [--force]` | вернуть имя «slot-N»: в слоте нет сессий, ветка влита или задача закрыта |

У всех команд `--json`; у `pen save|save-all|close|open|restart` — `--dry-run` (печатает AppleScript и план,
ничего не нажимает). Ошибки — по-русски в stderr (`--json` — `{error, code}` в stdout).

### Коды выхода

| Код | Значение |
| --- | --- |
| 0 | успех (в `wait` — маркер найден, без `--marker` — ход закончен) |
| 1 | ошибка |
| 2 | таймаут |
| 3 | сессия ждёт разрешения или ответа на вопрос (`send` в таком состоянии отказывает без `--force`) |
| 4 | ход закончен, маркера нет — вопрос, простой или забыл маркер |
| 5 | ошибка API в журнале |
| 6 | живой сессии в терминале нет |
| 7 | `send`: нет подтверждения за `--timeout` (или завис вызов superset) — сообщение **могло дойти**, не отправляйте повторно вслепую: `sess last` / `sess wait` без `--after` |
| 8 | `create`: достигнут лимит сессий |
| 9 | проверка не пройдена (`commit`, грязный слот) |

## Как `sess` находит журнал

1. `ps -axo pid,rss,command` — процессы `claude`; RSS — память процесса.
2. Окружение процесса (`ps -E` минус вывод без `-E`) — `SUPERSET_TERMINAL_ID`, `SUPERSET_WORKSPACE_ID`.
3. `~/.claude/sessions/<pid>.json` — текущий `sessionId`, `cwd`, `status` (busy/idle) от Claude Code.
4. Журнал — `~/.claude/projects/<cwd, всё кроме [A-Za-z0-9] → ->/<sessionId>.jsonl`; не нашёлся — поиск
   `<sessionId>.jsonl` по всем проектам.
5. Состояние «ждёт разрешения» — `superset snapshot` (`agent.state = blocked`).
6. claude, у которого среди предков есть другой claude (`claude -p` из скрипта сессии, подагент), —
   вложенный: он наследует `SUPERSET_TERMINAL_ID` родителя, поэтому отдельной сессией не считается; `ls`
   показывает их число и память.

Разбор журнала: сообщение человека — запись `user` с текстом (не `tool_result`; длинная вставка — в обёртке
`<pasted_content id=…>`, она при сверке отбрасывается) или `attachment`
`queued_command` (если сессия была занята); ответ — текстовые блоки `assistant` вне подагентов; конец хода —
`system/turn_duration` (с `pendingBackgroundAgentCount > 0` ход не считается законченным); ошибка API —
`assistant` с `isApiErrorMessage`. Всё это — в `src/journal.js` и его тестах.

**Ограничения.** Формат журнала Claude Code не документирован и может измениться. Сессия вне Superset
видна в `ls`, но без терминала — отправить ей нельзя. После `/clear` у процесса новый session id и новый
журнал: якорь старого `send` в нём не найдётся. `ps -E` видит только процессы текущего пользователя.
`send` сверяет начало текста (до 200 символов) — два одинаковых сообщения подряд различаются по времени.

## Формат плана `agent commit`

Правила проекта — `.agent-cli.json` в корне репозитория (раздел `commit`, см. ниже). Порядок работы:

1. Индекс до начала должен быть пуст — иначе отказ (чужие staged-изменения не трогаются). В репозитории
   без коммитов база сравнения — пустое дерево.
2. Сухой прогон: каждый коммит собирается во **временном индексе** (`GIT_INDEX_FILE`) и записывается
   объектом `commit-tree` — следующий коммит плана проверяется поверх предыдущего, а HEAD, ветка и
   рабочий индекс не меняются. Проверки: в индексе **ровно** заявленные файлы (каждый файл покрыт
   `paths`/`hunks`, каждый путь плана что-то дал), число ханков — как выбрано, нет `forbiddenPaths`,
   сообщение по `messagePattern` и `trailerPattern`.
3. `--apply` — после успешного сухого прогона то же на настоящем индексе и `git commit -F -` (хуки
   репозитория работают). Сбой посередине — сообщение со списком уже сделанных коммитов.
4. `closeChange` — после коммита элемента запускается `closeCommand`, проверяется индекс, коммит
   `closeMessage` (или сообщение из вывода команды по `closeMessageFrom`).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "agent commit plan",
  "oneOf": [
    { "$ref": "#/$defs/commits" },
    { "type": "object", "required": ["commits"], "properties": { "commits": { "$ref": "#/$defs/commits" } } }
  ],
  "$defs": {
    "commits": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/commit" } },
    "commit": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "message": { "type": "string", "minLength": 1, "description": "Полное сообщение: заголовок, тело, подвал" },
        "paths": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "description": "Файлы от корня репозитория — целиком (git add --), включая удаление; каталог — отказ"
        },
        "hunks": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["path", "include"],
            "additionalProperties": false,
            "properties": {
              "path": { "type": "string", "description": "Отслеживаемый файл, не указанный в paths" },
              "include": {
                "description": "Номера ханков из `agent commit hunks` (с 1) или маркер-подстрока / список маркеров",
                "oneOf": [
                  { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 1 },
                  { "type": "string", "minLength": 1 },
                  { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 }
                ]
              }
            }
          }
        },
        "closeChange": { "type": "string", "pattern": "^[\\w./-]+$", "description": "Задача для closeCommand после этого коммита" }
      },
      "anyOf": [
        { "required": ["message", "paths"] },
        { "required": ["message", "hunks"] },
        { "required": ["closeChange"], "not": { "anyOf": [{ "required": ["paths"] }, { "required": ["hunks"] }] } }
      ]
    }
  }
}
```

Пример:

```json
[
  {
    "message": "feat(store-delivery): поле «Доставка» в политике магазина\n\nЧто получилось…\n\nCo-Authored-By: …",
    "paths": ["libs/backend/automation/src/policy.ts", "apps/web/src/app/settings/store.tsx"],
    "hunks": [{ "path": "README.md", "include": "Доставка" }]
  },
  { "closeChange": "store-delivery" }
]
```

### `.agent-cli.json`

```json
{
  "commit": {
    "forbiddenPaths": ["node_modules/**", ".env.local", "**/*.pem"],
    "messagePattern": "^(feat|fix|docs)\\([^)]+\\): \\S|^close\\((change|step)\\): \\S",
    "trailerPattern": "^Co-Authored-By: ",
    "closeCommand": "node .ai/tools/close-change.mjs {task}",
    "closeMessage": "close(change): {task}",
    "closeMessageFrom": "Сообщение коммита: (.+)",
    "closeRequires": [".ai/changes/{task}.md"]
  },
  "slot": {
    "mainBranch": "main",
    "prepare": [
      { "symlinkIfMissing": "node_modules" },
      { "copyIfMissing": [".env.local", "config/worker/development.json"] },
      { "run": "npx prisma generate", "ifChanged": ["prisma/"] }
    ]
  }
}
```

- `forbiddenPaths` — glob от корня: `**` — любые каталоги, `*`/`?` — внутри сегмента; шаблон без `/`
  сравнивается с именем в любом каталоге.
- `trailerPattern` проверяется у сообщений плана, не у сообщений закрытия.
- `closeMessage` или `closeMessageFrom` — одно из двух; `closeRequires` — пути, из которых хотя бы один
  должен существовать (иначе предупреждение в сухом прогоне).
- `closeCommand` и `run` разбиваются по пробелам и запускаются без оболочки.

## Слоты

Слот — воркспейс Superset с префиксом имени `slot-N`: свободный называется «slot-N», занятый — «slot-N ·
<задача>». Папка worktree при этом не меняется, поэтому слот задаётся именем воркспейса, «slot-N» или id.

`slot prepare`:

1. Живая сессия в слоте (по воркспейсу или cwd) → отказ (`--force` — если так и нужно). Основную копию
   проекта не переключает никогда; существующую ветку не пересоздаёт.
2. Грязный слот → копия изменённых и неотслеживаемых файлов, `status.txt` и `diff.patch` в
   `~/.agent-cli/backups/<слот>-<время>/`, затем остановка с кодом 9. `--carry` — после копии
   `git switch -c B <from>` с переносом правок поверх.
3. Чистый слот → `git switch -c B <from>` (по умолчанию `main`).
4. Хуки из `.agent-cli.json` новой ветки: `symlinkIfMissing` и `copyIfMissing` — из основной копии
   проекта (`superset projects list`), если в слоте файла нет; `run` — команда в слоте, с `ifChanged` —
   только если пути отличаются от `<from>` (с учётом рабочей копии).
5. Имя воркспейса → «slot-N · <--task или ветка>» (`superset ws update --name`).

`slot release` (и `gc`, когда в слоте не осталось сессий) возвращает «slot-N», если ветка влита в
`mainBranch` или задача закрыта — последний коммит по `slot.closedSubject` (по умолчанию `^close\(`).

## `sess gc`

По умолчанию — только проект воркспейса, из которого вызван CLI (`SUPERSET_WORKSPACE_ID` или cwd);
другие — явно `--project a,b`. Закрывает (без `--apply` — только показывает):

- сессии в состоянии idle с маркером «готово» в последнем ответе (`--done`, по умолчанию `[[DONE…]]`) или
  без изменений журнала дольше `--idle` (30m); session id — в реестр, как при `close`;
- терминалы с `exited` и агентом в состоянии `exited`; пустые шеллы — без агента, без заголовка и с
  экраном-приглашением (`terminals read`);
- панели, чей терминал не живёт в воркспейсе (иначе приложение показывает мёртвые сессии);
- освобождает слоты (см. выше) и закрывает Pen через `pen idle-check` (`--keep-pen` — не трогать).

Никогда не закрывает: работающие, ждущие разрешения, с вопросом в последнем ответе (строка на «?»),
с пометкой keep и сессию, из которой вызван CLI.

## pen

Нужен «Универсальный доступ» для приложения, из которого запущен `agent` (Superset, Terminal):
Системные настройки › Конфиденциальность и безопасность › Универсальный доступ. Без него `osascript`
возвращает -1719, и CLI пишет подсказку. ⌘S из скрипта в Pen не срабатывает — только пункт меню.
Окно задаётся номером из `ls`, путём к `.pen` или частью заголовка. Если файл окна неизвестен или mtime не
изменился (несохранённых правок не было), `save` пишет это прямо, `verified: false` в `--json`.
Имена меню и приложения переопределяются в конфиге: `"pen": {"fileMenu": "File", "save": "Save"}`.

`pen quit` и `pen idle-check` считают файл занятым, если он лежит в worktree живой сессии, которая работает
или ждёт ответа, или если журнал живой сессии упоминал его имя за `--recent` (30 мин). Сессия, из
которой вызван CLI, не считается. Занят → `quit` отказывает с кодом 9 (`--force` обходит),
`idle-check` оставляет Pen открытым.

## Где лежат данные

`~/.agent-cli/` (или `$AGENT_CLI_HOME`); реестр пишется атомарно, с правами 600:

- `config.json` — `maxSessions` (5), `superset` (`~/.superset/bin/superset`), `sendAcceptTimeoutSec` (20), `pen`;
- `sessions.json` — реестр закрытых сессий, алиасы и `keep`; `agent sess forget` удаляет запись;
- `backups/` — копии грязных слотов; автоматически не чистится.

## Тесты

```sh
npm test            # node --test 'test/*.test.js'; git — настоящий во временных репозиториях,
                    # superset, ps и osascript — заглушки
```
