# Paradev Agent Tools

Приватный комплект для Codex и OpenCode. Оба клиента запускают один локальный MCP-сервер по stdio. Исполнители в Paradev — Codex chat, терминальный Codex и Claude Code. Управление Pen остаётся в личном CLI через `agent pen` и скилл `agent-pen`.

## Установка на macOS

1. Распакуйте ZIP в Finder и откройте **Paradev Agent Tools.app**. Для Apple Silicon выберите архив `macos-arm64.zip`, для Intel — `macos-x64.zip`, если он включён в поставку. Требуется macOS 13 или новее. Node.js входит в приложение. Для рабочих команд нужны Git и открытый [Paradev Desktop](https://paradev.ai/).
2. Нажмите **Подключить Codex** или **Подключить OpenCode**. Подключение Codex выполняет CLI из приложения. Если он недоступен, окно подскажет точное имя локального каталога для установки через **Plugins**. Для OpenCode окно спросит версию только тогда, когда её не удалось определить.
3. Перезапустите подключённый клиент, откройте новый чат в папке проекта и напишите «Проверь статус этого проекта через Paradev Agent Tools». Кнопка **Проверить Paradev** в приложении проверяет хост и обязательные зависимости.

Для обновления откройте приложение из нового ZIP и снова нажмите ту же кнопку. Если клиент уже открыт, перезапустите его. Приложение подписано локальной ad hoc подписью. Если macOS блокирует первое открытие доверенного внутреннего архива, действуйте по правилам вашей организации для локальных приложений.

## Установка на Linux x64

1. Распакуйте `linux-x64.tar.gz`. Нужны Git, `ps`, `lsof` и локальный хост Paradev. Node.js входит в архив.
2. Для графического подключения с установленным Zenity запустите `Setup.sh` как программу из файлового менеджера и выберите клиент. Для подключения в терминале из распакованной папки используйте `./multi-agent-mcp/launch --install codex` или `./multi-agent-mcp/launch --install opencode-auto`. Если версия OpenCode не определяется, укажите `opencode` для версии 2 или `opencode-v1` для версии 1.
3. Перезапустите клиент, откройте чат в папке проекта и попросите проверить статус через **Paradev Agent Tools**. Для диагностики используйте пункт **Проверить Paradev** или `./multi-agent-mcp/launch --diagnose`.

Linux AppImage Paradev экспериментальный. Подходит также самостоятельный локальный хост Paradev. Для Windows доступен сценарий с WSL2 x64, если хост Paradev, AI-клиент и репозиторий работают внутри одного Linux-окружения. Нативная версия зависит от появления хоста Paradev для Windows. [Платформы Paradev](https://docs.paradev.com/install) · [Локальный хост](https://docs.paradev.com/cli/host-server)

## Настройки клиентов

Приложение добавляет одну запись в личный каталог Codex `~/.agents/plugins/marketplace.json` или один сервер в глобальный `opencode.json(c)`. Соседние настройки и комментарии JSONC сохраняются. Уже существующий одноимённый пользовательский скилл вызывает конфликт, изменённый пользователем скилл из прежней установки сохраняется. Для OpenCode с нестандартным `OPENCODE_CONFIG` добавьте запись в этот файл через редактор и скопируйте скилл `skills/multi-agent-mcp` из установленного пакета в каталог пользовательских скиллов. Подставьте абсолютный путь к `launch` вместо примера.

OpenCode 2:

```json
{"mcp":{"servers":{"multi-agent-mcp":{"type":"local","command":["/absolute/path/to/multi-agent-mcp/launch"],"timeout":{"execution":180000}}}}}
```

OpenCode 1:

```json
{"mcp":{"multi-agent-mcp":{"type":"local","command":["/absolute/path/to/multi-agent-mcp/launch"],"timeout":180000}}}
```

Параметры MCP для Codex входят в манифест пакета. Сервер не требует npm, глобального `agent`, HTTP-порта или аккаунта MCP. Диагностика подтверждает связь с локальным хостом отдельно от проверки бинарника. В списке PID `exited` означает ESRCH, `permission-denied` означает, что песочница не дала проверить процесс. Хостом управляет приложение Paradev/Superset Desktop. Отчёт выводит путь к манифесту, PID и результат проверки процесса.

## Работа из чата

Путь `cwd` для статуса, слотов, создания и продолжения сессии, закрытия, коммита и уборки передаётся явно. `projects` возвращает зарегистрированные checkout и ID. Для вложенных каталогов выбирается наиболее близкий зарегистрированный worktree. Для отдельных слотов допустим путь основной копии того же проекта и точный ID цели. Результаты сессии идентифицируются точной парой `workspaceId` и `sessionId`. Если транспорт сменил ID после send/resume, используйте новый ID из результата или списка. Рабочий каталог сервера может быть где угодно.

Пример запроса: «В проекте X возьми отдельный слот, запусти Codex для задачи Y и дай мне ID». Агент проверяет правила проекта, выполняет `slot_take` и передаёт выданный workspace в `session_create`. После уточнения проверяет подтверждение `session_send`. Код 7 означает неопределённую доставку. Читайте `session_journal` и сверяйте текст и время до новой отправки. У `session_wait` таймаут по умолчанию 15 секунд, продолжение использует тот же якорь. `idle` означает конец хода. Для завершения задачи проверьте сам ответ. После `session_close` проверяйте `close` и `release`; для `queued` используйте `close_result` после выдачи receipt. При `partial` проверьте причину, состояние сессии и слот до следующего действия. Preview коммитов, уборки, переноса локальных файлов и установки исполнителей включён по умолчанию.

## Покрытие команд

| CLI | MCP или настройка |
| --- | --- |
| `status`, `doctor` | `status`, `diagnose`; `projects` помогает выбрать каталог |
| `ls`, `log`, `create` | `session_list`, `session_history`, `session_create` |
| `send`, `wait`, `last` | `session_send`, `session_wait`, `session_last`; `session_journal` читает записи |
| `resume`, `close`, `close --result` | `session_resume`, `session_close`, `close_result` |
| `alias`, `keep`, `forget`, `gc` | `aliases` и `session_alias`, `kept_sessions` и `session_keep`, `session_forget`, `cleanup` |
| `slot ls/create/take/prepare` | `slot_list/create/take/prepare` |
| `slot sync/sync-back/release` | `slot_sync`, `slot_sync_back`, `session_close` |
| `commit`, `commit hunks` | `commit_plan`, `commit_hunks` |
| `skills list/path/install` | `skills_list`, `skill_read`, `executor_install_skills` |
| Настройка исполнителя, `hook install` | `executor_install`, `executor_install_hooks` |
| `hook session-start/stop/session-end` | Именованные lifecycle handlers Codex/Claude, вызываемые исполнителем |
| `sess …`, `finish` | Канонические инструменты сессии; `finish` использует `session_close` |
| `--help` | Описание и JSON Schema в `tools/list` и встроенные скиллы |

## Скиллы и хуки

- **Codex как оркестратор.** Скилл `multi-agent-mcp` в плагине задаёт порядок действий из чата. Клиент запускает MCP по манифесту. Плагин не регистрирует одноимённые lifecycle hooks поверх пользовательских.
- **OpenCode как оркестратор.** Setup подключает MCP и пользовательский скилл. Доступные в OpenCode V2 серверные хуки и события, в частности `session.idle`, описывают собственные ходы OpenCode. Плагин получает состояние и факт закрытия исполнителя через Paradev. Хуки оркестратора для этого не нужны.
- **Исполнитель Codex/Claude.** По явному поручению выполните `executor_install` сначала в режиме предпросмотра, затем с `dryRun: false`. Плагин устанавливает роутер, сохраняет личные дополнения и добавляет именованные `SessionStart`, `Stop`, `SessionEnd`. Эти хуки сохраняют контекст и результат и могут запланировать release после завершения транспорта. Codex должен доверять текущим определениям хуков. Если хост Codex показывает запрос, подтвердите их в интерфейсе доверия хукам. Терминальный интерфейс Codex показывает их по `/hooks`; внутри чата Paradev её нет. Обычный внешний close через MCP использует штатную проверку закрытия и release независимо от установки этих хуков.

## Сборка и источники форматов

Имя архива включает версию плагина из `mcp/plugin.json`, ОС и архитектуру. На macOS с Xcode Command Line Tools и официальным Node.js LTS `npm run build:mcp` собирает пакет для текущей архитектуры. Для сборки Linux x64 на Mac передайте каталог распакованного официального Node.js LTS для Linux x64 с файлом LICENSE.

```sh
npm run build:mcp -- --target linux-x64 --node-dir /absolute/path/to/node-linux-x64
```

`npm test` проверяет CLI и MCP.

- [Codex · личный локальный каталог и формат плагина](https://developers.openai.com/plugins/build/plugins)
- [Codex · запуск локального stdio](https://developers.openai.com/plugins/deploy/desktop-only)
- [OpenCode · MCP v2](https://opencode.ai/docs/mcp-servers/)
- [OpenCode · переход с v1](https://opencode.ai/docs/migrate-v1/)
- [OpenCode · серверный lifecycle](https://opencode.ai/docs/build/plugins/server/)
- [OpenCode · обнаружение скиллов](https://opencode.ai/docs/skills/)
- [MCP · транспорт stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
