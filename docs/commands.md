# Справочник команд

Обычный путь работы — [в руководстве по CLI](cli.md#обычный-путь-работы). В терминале: `paradev-agent --help`,
`paradev-agent resume --help`, `paradev-agent close --help`. Ниже — полный список, включая служебные операции.

| Команда | Что делает |
| --- | --- |
| `paradev-agent install [--directory D] [--dry-run]` | создать ссылку на CLI, по умолчанию `~/.local/bin/paradev-agent` |
| `paradev-agent status [--json]` | текущий проект, workspace/слот, фактическая Git-ветка, изменения и живые сессии |
| `paradev-agent --help <тема>` | показать полный встроенный процесс без подключения к Paradev |
| `paradev-agent install --agent codex\|claude\|all [--directory D] [--dry-run] [--force]` | подключить короткий роутер для рабочих подсказок в чате |
| `paradev-agent doctor` | проверить зависимости и наличие роутеров без изменения настроек |
| `paradev-agent ls [--json]` | все Codex/Claude-сессии Мака: агент/режим (chat или cli), терминал, алиас, состояние, RSS, проект/воркспейс, заголовок, session id; «N из лимита» |
| `paradev-agent log [--project P] [--task KEY] [--json]` | локальная история без Superset; полные UUID, контекст, заметки и события; JSON: sessions и events |
| `paradev-agent create --workspace W --prompt-file F [--branch B] [--task KEY] [--agent codex\|claude] [--cli] [--mode MODE] [--model M] [--effort E] [--alias A]` | Codex chat по умолчанию; `--cli` — прежний терминальный Codex, Claude остаётся терминальным; возвращает терминал, тип агента и его session id; общий лимит для Codex и Claude |
| `paradev-agent create --project P --branch B --prompt-file F [--task T] [--from BASE] [--allow-create]` | подготовить первый свободный слот по номеру и запустить сессию. Нет слотов — задать вопрос. В JSON код 3 и `status: confirmation_required`. Повторить с `--allow-create` после согласия |
| `paradev-agent send <терм\|алиас> --file F \| --text T [--timeout 20] [--force]` | отправить и нажать Enter; ждёт, пока сообщение появится в журнале (весь срок — `--timeout`, по умолчанию `sendAcceptTimeoutSec`); печатает **якорь** — непрозрачный идентификатор записи |
| `paradev-agent wait <терм\|алиас> [--marker NAME] [--after ЯКОРЬ] [--timeout 1800] [--interval 5]` | ждать `[[NAME]]` в ответе ассистента после якоря; печатает последний ответ целиком; при коде 3 — ещё текст с экрана терминала и вид ожидания (`waiting`: `question` — вопрос с вариантами, `permission` — запрос разрешения, `unknown`; в `--json` — `kind`, `text`, `options`) |
| `paradev-agent last [<терм\|алиас>]` | последний ответ ассистента целиком; если сессия ждёт — ниже экран и `waiting`, как в `wait` |
| `paradev-agent close [<UUID\|алиас>] [--workspace W] [--session-only] [--after-reply] [--note T] [--summary-file F] [--reason T] [--dry-run]` | сохранить историю и закрыть сессию. `--session-only` сохраняет назначение слота. `--after-reply` с точными UUID чата и workspace ждёт финальный ответ с receipt. Для release нужен чистый слот без других сессий |
| `paradev-agent task complete CHAT_ID --workspace WORKSPACE_ID [--dry-run]` | запросить освобождение слота после завершения задачи и сохранить чат открытым |
| `paradev-agent close --result F` | прочитать результат worker, отдельно close/release/notification |
| `paradev-agent activity FILE... [--recent 30m]` | вывести связанные живые сессии по файлам. JSON возвращает `busy` с файлом, терминалом и причиной |
| `paradev-agent hook install [--agent codex\|claude] [--dry-run]` | добавить SessionStart/Stop/SessionEnd и UserPromptSubmit для Codex, сохранив существующие хуки и бэкап; Codex требует доверия через /hooks |
| `paradev-agent hook session-start\|user-prompt-submit\|stop\|session-end --agent codex\|claude` | служебные обработчики JSON runtime на stdin; checkpoint и release после фактического закрытия; в случае отказа UserPromptSubmit возвращает Codex решение `block` с вопросом |
| `paradev-agent resume [<UUID\|алиас> \| --task KEY \| --last-closed \| --all-open] [--project P] [--workspace W] [--branch B] [--prompt-file F] [--dry-run] [--offline]` | продолжить сессию с заметкой; проверить лимит, назначение и занятость, при необходимости подготовить слот; свою грязную ветку не переключать; неоднозначность — выбор UUID, пакет — результаты по каждой сессии |
| `paradev-agent alias [<имя> <терм>] [--rm имя]` · `paradev-agent forget <id\|алиас>` | алиасы «задача → терминал»; удалить запись реестра |
| `paradev-agent keep [<терм\|алиас\|id>]` · `paradev-agent keep --rm <…>` | пометка keep: `gc` эту сессию не закрывает |
| `paradev-agent gc [--project P[,P2]] [--idle 30m] [--done REGEX] [--apply]` | уборка: законченные сессии, завершившиеся терминалы, пустые шеллы, панели без терминала, освобождение слотов; без `--apply` — только план |
| `paradev-agent commit <план.json> [--apply]` | коммиты по плану; без `--apply` — сухой прогон |
| `paradev-agent commit hunks <путь…>` | пронумерованные ханки неиндексированных изменений — для `include` |
| `paradev-agent slot ls [--project P]` | слоты: имя, ветка, чисто/грязно, влита ли ветка в `mainBranch` (локальную или `origin/…`), есть ли живая сессия |
| `paradev-agent slot prepare <слот> --branch B [--task T] [--from BASE] [--offline] [--carry] [--allow-unmerged] [--dry-run] [--project P] [--force]` | взять слот: fetch с prune до встроенной подготовки или `slot.take` проекта; новая ветка от полученного SHA `origin/BASE`, существующая — fast-forward от origin; ошибки обновления и устаревший результат команды проекта останавливают подготовку; шаги подготовки, локальные файлы в обе стороны, имя «slot-N · T» после проверки (по умолчанию T — ветка); `--dry-run` — только fetch и план |
| `paradev-agent slot create --project P [--name slot-N] [--base BASE] [--offline] [--dry-run]` | новый слот, когда свободных нет: воркспейс Superset без агента в папке `…/slot-N`, без ветки на свежем `origin/BASE`, чистый, имя «slot-N» (по умолчанию — следующий свободный номер); печатает id воркспейса |
| `paradev-agent slot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]` | взять слот одной командой: свободный слот проекта, а нет его — `create`; затем `prepare`; последняя строка — id воркспейса (`--json`: `.workspace`) для `create` |
| `paradev-agent slot sync-back [<слот>] [--apply]` | локальные файлы (`slot.localFiles`) слот → основная копия; без `--apply` — сухой прогон; конфликт — код 9 |
| `paradev-agent slot sync [<слот>] [--apply]` | то же, затем основная копия → слот (как при `prepare`, без смены ветки) |

У всех команд есть `--json`. Ошибки — по-русски в stderr (`--json` — `{error, code}` в stdout).


Старые `paradev-agent sess …`, `paradev-agent finish [--release-slot]` и `paradev-agent slot release` поддерживаются для совместимости.
`finish` и `slot release` ведут в ту же операцию close; отдельного режима «только сохранить» нет.
