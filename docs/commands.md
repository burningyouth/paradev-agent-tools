# Справочник команд

Обычный путь работы — [в README](../README.md#обычный-путь-работы). В терминале: `agent --help`,
`agent sess --help`, `agent sess finish --help`. Ниже — полный список, включая служебные операции.

| Команда | Что делает |
| --- | --- |
| `agent status [--json]` | текущий проект, workspace/слот, фактическая Git-ветка, изменения и живые сессии |
| `agent skills list` · `agent skills path <имя>` | список встроенных процессов и абсолютный путь к SKILL.md; без Superset и пользовательского конфига |
| `agent skills install [--agent codex\|claude\|all] [--directory D] [--dry-run] [--force]` | подключить короткий роутер агентам; без --agent — интерактивный выбор |
| `agent doctor` | проверить зависимости и наличие роутеров без изменения настроек |
| `agent sess ls [--json]` | все Codex/Claude-сессии Мака: агент/режим (chat или cli), терминал, алиас, состояние, RSS, проект/воркспейс, заголовок, session id; «N из лимита» |
| `agent sess create --workspace W --prompt-file F [--branch B] [--task KEY] [--agent codex\|claude] [--cli] [--mode MODE] [--model M] [--effort E] [--alias A] [--force]` | Codex chat по умолчанию; `--cli` — прежний терминальный Codex, Claude остаётся терминальным; возвращает терминал, тип агента и его session id; общий лимит для Codex и Claude |
| `agent sess send <терм\|алиас> --file F \| --text T [--timeout 20] [--force]` | отправить и нажать Enter; ждёт, пока сообщение появится в журнале (весь срок — `--timeout`, по умолчанию `sendAcceptTimeoutSec`); печатает **якорь** — непрозрачный идентификатор записи |
| `agent sess wait <терм\|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]` | ждать `[[NAME]]` в ответе ассистента после якоря; печатает последний ответ целиком; при коде 3 — ещё текст с экрана терминала и вид ожидания (`waiting`: `question` — вопрос с вариантами, `permission` — запрос разрешения, `unknown`; в `--json` — `kind`, `text`, `options`) |
| `agent sess last [<терм\|алиас>]` | последний ответ ассистента целиком; если сессия ждёт — ниже экран и `waiting`, как в `wait` |
| `agent sess close [<терм\|алиас>] [--note T] [--force]` | без ID — текущая сессия или единственная живая в текущем workspace; сохранить session id, воркспейс, cwd, заметку в реестр и закрыть chat через `sessions close` либо терминал через `panes close`; для терминального режима затем пустые шеллы и панели без терминала того же воркспейса; слоту без сессий с чистой копией — имя «slot-N» и перенос его локальных файлов в основную копию; работающую — только с `--force`; ждёт выхода процесса до 10 с |
| `agent sess finish --release-slot --summary-file F` | завершить свою задачу: сохранить итог, подтвердить финальный ответ, закрыть чат и отпустить слот; [условия](../README.md#sess-finish-завершить-свою-задачу-и-освободить-слот) |
| `agent sess finish --result F` | прочитать результат worker, отдельно close/release/notification |
| `agent sess resume <session-id\|алиас> [--workspace W] [--prompt-file F] [--agent codex\|claude]` | chat возобновить через `sessions resume`, терминальную сессию — через пресет и `--resume-session`; агент из реестра, у старых записей — `claude`; неизвестный id — `codex` по умолчанию, нужен `--workspace` |
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
| `agent slot ls [--project P]` | слоты: имя, ветка, чисто/грязно, влита ли ветка в `mainBranch` (локальную или `origin/…`), есть ли живая сессия |
| `agent slot prepare <слот> --branch B [--task T] [--from BASE] [--offline] [--carry] [--allow-unmerged] [--dry-run] [--project P] [--force]` | взять слот: `slot.take` проекта или встроенное — новая ветка от свежего `origin/BASE` или существующая (fast-forward от origin), шаги подготовки (по умолчанию — по lock-файлам и хукам), локальные файлы в обе стороны, имя «slot-N · T» (по умолчанию T — ветка); `--dry-run` — только fetch и план |
| `agent slot create --project P [--name slot-N] [--base BASE] [--offline] [--dry-run]` | новый слот, когда свободных нет: воркспейс Superset без агента в папке `…/slot-N`, без ветки на свежем `origin/BASE`, чистый, имя «slot-N» (по умолчанию — следующий свободный номер); печатает id воркспейса |
| `agent slot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]` | взять слот одной командой: свободный слот проекта, а нет его — `create`; затем `prepare`; последняя строка — id воркспейса (`--json`: `.workspace`) для `sess create` |
| `agent slot release [<слот>] [--from BASE] [--offline]` | отпустить слот: `slot.release` проекта или встроенное — чистая копия без ветки на свежем `origin/BASE` (ветка остаётся); локальные файлы слота → основная копия; имя «slot-N» |
| `agent slot sync-back [<слот>] [--apply]` | локальные файлы (`slot.localFiles`) слот → основная копия; без `--apply` — сухой прогон; конфликт — код 9 |
| `agent slot sync [<слот>] [--apply]` | то же, затем основная копия → слот (как при `prepare`, без смены ветки) |

У всех команд `--json`; у `pen save|save-all|close|open|restart` — `--dry-run` (печатает AppleScript и план,
ничего не нажимает). Ошибки — по-русски в stderr (`--json` — `{error, code}` в stdout).

