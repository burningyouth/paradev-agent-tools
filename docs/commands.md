# Справочник команд

Обычный путь работы — [в README](../README.md#обычный-путь-работы). В терминале: `agent --help`,
`agent resume --help`, `agent close --help`. Ниже — полный список, включая служебные операции.

| Команда | Что делает |
| --- | --- |
| `agent install [--agent codex\|claude\|all] [--dry-run] [--force]` | единая настройка: найденные Codex/Claude, роутеры, именованные хуки и doctor; перед записями проверяет назначения; конфликты роутера требуют --force с бэкапом; JSON отдельно показывает установку и готовность зависимостей |
| `agent status [--json]` | текущий проект, workspace/слот, фактическая Git-ветка, изменения и живые сессии |
| `agent skills list` · `agent skills path <имя>` | список встроенных процессов и абсолютный путь к SKILL.md; без Superset и пользовательского конфига |
| `agent skills install [--agent codex\|claude\|all] [--directory D] [--dry-run] [--force]` | подключить короткий роутер агентам; без --agent — интерактивный выбор |
| `agent doctor` | проверить зависимости и наличие роутеров без изменения настроек |
| `agent ls [--json]` | все Codex/Claude-сессии Мака: агент/режим (chat или cli), терминал, алиас, состояние, RSS, проект/воркспейс, заголовок, session id; «N из лимита» |
| `agent log [--project P] [--task KEY] [--json]` | локальная история без Superset; полные UUID, контекст, заметки и события; JSON: sessions и events |
| `agent create --workspace W --prompt-file F [--branch B] [--task KEY] [--agent codex\|claude] [--cli] [--mode MODE] [--model M] [--effort E] [--alias A]` | Codex chat по умолчанию; `--cli` — прежний терминальный Codex, Claude остаётся терминальным; возвращает терминал, тип агента и его session id; общий лимит для Codex и Claude |
| `agent send <терм\|алиас> --file F \| --text T [--timeout 20] [--force]` | отправить и нажать Enter; ждёт, пока сообщение появится в журнале (весь срок — `--timeout`, по умолчанию `sendAcceptTimeoutSec`); печатает **якорь** — непрозрачный идентификатор записи |
| `agent wait <терм\|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]` | ждать `[[NAME]]` в ответе ассистента после якоря; печатает последний ответ целиком; при коде 3 — ещё текст с экрана терминала и вид ожидания (`waiting`: `question` — вопрос с вариантами, `permission` — запрос разрешения, `unknown`; в `--json` — `kind`, `text`, `options`) |
| `agent last [<терм\|алиас>]` | последний ответ ассистента целиком; если сессия ждёт — ниже экран и `waiting`, как в `wait` |
| `agent close [<UUID\|алиас>] [--workspace W] [--note T] [--summary-file F] [--reason T] [--dry-run]` | сохранить историю, закрыть сессию, освободить слот и проверить результат; без ID — текущий контекст; собственный chat в слоте ждёт финальный receipt; queued не означает completed; грязный или занятый слот — блокер |
| `agent close --result F` | прочитать результат worker, отдельно close/release/notification |
| `agent hook install [--agent codex\|claude] [--dry-run]` | добавить SessionStart/Stop/SessionEnd, сохранив существующие хуки и бэкап; Codex требует доверия через /hooks |
| `agent hook session-start\|stop\|session-end --agent codex\|claude` | служебные обработчики JSON runtime на stdin; checkpoint и release после фактического закрытия; без --json выводят нейтральный протокол `{}` |
| `agent resume [<UUID\|алиас> \| --task KEY \| --last-closed \| --all-open] [--project P] [--workspace W] [--branch B] [--prompt-file F] [--dry-run] [--offline]` | продолжить сессию с заметкой; проверить лимит, назначение и занятость, при необходимости подготовить слот; свою грязную ветку не переключать; неоднозначность — выбор UUID, пакет — результаты по каждой сессии |
| `agent alias [<имя> <терм>] [--rm имя]` · `agent forget <id\|алиас>` | алиасы «задача → терминал»; удалить запись реестра |
| `agent keep [<терм\|алиас\|id>]` · `agent keep --rm <…>` | пометка keep: `gc` эту сессию не закрывает |
| `agent gc [--project P[,P2]] [--idle 30m] [--done REGEX] [--keep-pen] [--apply]` | уборка: законченные сессии, завершившиеся терминалы, пустые шеллы, панели без терминала, освобождение слотов, Pen без пользователей; без `--apply` — только план |
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
| `agent slot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]` | взять слот одной командой: свободный слот проекта, а нет его — `create`; затем `prepare`; последняя строка — id воркспейса (`--json`: `.workspace`) для `create` |
| `agent slot sync-back [<слот>] [--apply]` | локальные файлы (`slot.localFiles`) слот → основная копия; без `--apply` — сухой прогон; конфликт — код 9 |
| `agent slot sync [<слот>] [--apply]` | то же, затем основная копия → слот (как при `prepare`, без смены ветки) |

У всех команд `--json`; у `pen save|save-all|close|open|restart` — `--dry-run` (печатает AppleScript и план,
ничего не нажимает). Ошибки — по-русски в stderr (`--json` — `{error, code}` в stdout).


Старые `agent sess …`, `agent finish [--release-slot]` и `agent slot release` поддерживаются для совместимости.
`finish` и `slot release` ведут в ту же операцию close; отдельного режима «только сохранить» нет.
