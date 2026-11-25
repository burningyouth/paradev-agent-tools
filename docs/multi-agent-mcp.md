# Paradev Agent Tools

Комплект для клиентов с поддержкой локального MCP по stdio. Установщик подключает Codex, OpenCode и Kilo. Для других клиентов есть ручная настройка. Исполнители в Paradev — Codex chat, терминальный Codex и Claude Code. Управление Pen подключается отдельно. [pen-cli](https://github.com/burningyouth/pen-cli)

## Установка

### Штатные пакеты Codex и OpenCode 2

Оба клиента получают пакеты из ветки `distribution`. В пакете есть Go-бинарники для macOS и Linux на arm64 и amd64. Node.js, npm и Go при установке не нужны. Для хуков подготовьте постоянный путь к `launch` с помощью [Git-клона](#установка-из-git-для-mcp-клиентов-и-хуков) и режима `manual`. Можно использовать и путь от ранее установленного архива.

**Codex.** Добавьте маркетплейс и установите пакет.

```sh
codex plugin marketplace add burningyouth/paradev-agent-tools --ref distribution
codex plugin add paradev-agent-tools@burningyouth
```

Если ранее установили локальную версию, проверьте Git-версию в новом чате и отключите прежнюю в **Plugins**. Если Git-источник уже подключён под прежним именем, [обновите его регистрацию](#переход-на-маркетплейс-burningyouth). Codex может автоматически обновить Git-маркетплейс при запуске. Для ручного обновления выполните `codex plugin marketplace upgrade burningyouth`, перезапустите клиент и откройте новый чат. [Документация Codex](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)

**OpenCode 2.3.1 и новее.** Добавьте пакет.

```sh
opencode plugin add 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'
```

В OpenCode Desktop обновите его через **Settings → Extensions → Check for updates → Update**. В терминале выполните `opencode plugin update 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'`. Пакет использует прежнее имя MCP-сервера и сохраняет параметры существующей записи, созданной установщиком. Если OpenCode всё ещё использует старую версию, перезапустите его сервер. [Документация OpenCode](https://opencode.ai/docs/plugins/) · [Журнал изменений OpenCode](https://opencode.ai/changelog)

#### Переход на маркетплейс burningyouth

Если `codex plugin marketplace list` показывает старый Git-маркетплейс `paradev-agent-tools`, удалите его регистрацию и снова добавьте тот же репозиторий.

```sh
codex plugin marketplace remove paradev-agent-tools
codex plugin marketplace add burningyouth/paradev-agent-tools --ref distribution
codex plugin add paradev-agent-tools@burningyouth
```

Перезапустите Codex и проверьте новый плагин в новом чате. Если прежняя установка ещё подключена, удалите её командой `codex plugin remove multi-agent-mcp@paradev-agent-tools`.

### Установка из Git для MCP-клиентов и хуков

**Шаг 1. Клонируйте репозиторий.** Готовый пакет публикуется в ветке `distribution`. Если клон уже есть, переходите к шагу 2.

```sh
git clone --branch distribution --single-branch https://github.com/burningyouth/paradev-agent-tools.git "$HOME/paradev-agent-tools"
```

**Шаг 2. Подключите клиент.** Выберите одну команду из таблицы и выполните её один раз.

| Клиент | Команда |
| --- | --- |
| Kilo Code / Kilo CLI | `"$HOME/paradev-agent-tools/plugins/paradev-agent-tools/launch" --install kilo --link` |
| OpenCode 1 | `"$HOME/paradev-agent-tools/plugins/paradev-agent-tools/launch" --install opencode-v1 --link` |
| Claude Code, Gemini CLI, другой MCP-клиент или подготовка хуков | `"$HOME/paradev-agent-tools/plugins/paradev-agent-tools/launch" --install manual --link` |

Установщик связывает `~/.codex/plugins/multi-agent-mcp/` с клоном. Kilo и OpenCode 1 получают настройку MCP сразу. В Claude Code, Gemini CLI и других клиентах один раз [зарегистрируйте сервер](#другие-mcp-клиенты). Если сервер уже подключён по этому пути, его настройки можно использовать дальше. При переходе с установки из архива старая копия сохраняется в резерве.

**Обновление.** Закройте клиент, выполните команду ниже и снова откройте клиент. Он загрузит новый сервер из клона. Хуки используют новый код при следующем запуске. Повторная установка и регистрация MCP не нужны.

```sh
git -C "$HOME/paradev-agent-tools" pull --ff-only
```

Для диагностики выполните `"$HOME/.codex/plugins/multi-agent-mcp/launch" --diagnose`.

### Установка из архива

Распакуйте `paradev-agent-tools.tar.gz`. Для установки нужны права обычного пользователя. [Скачать плагин](https://github.com/burningyouth/paradev-agent-tools/releases/latest/download/paradev-agent-tools.tar.gz)

- **macOS.** Откройте `Install.command`.
- **Linux.** Запустите `./Install.sh`. Для диагностики нужны `ps` и `lsof`.

Для работы с проектами нужны Git и локальный хост Paradev. На Windows запускайте `Install.sh` внутри WSL2 x64, где работают хост Paradev, AI-клиент и репозиторий. [Платформы Paradev](https://docs.paradev.com/install) · [Локальный хост](https://docs.paradev.com/cli/host-server)

#### Codex, OpenCode и Kilo

В меню Codex и OpenCode 2 по умолчанию подключаются через Git. Для установки без доступа к GitHub выберите пункт **из распакованного комплекта** или передайте `--local`. Если версия OpenCode не определится, меню предложит указать её. На macOS используйте `Install.command`, на Linux — `Install.sh`.

```sh
./Install.command codex --local
./Install.command opencode-auto --local
./Install.command kilo
```

Если Codex попросит завершить подключение через **Plugins**, утилита покажет имя каталога. Если версия OpenCode не определяется, передайте `opencode` для версии 2 или `opencode-v1` для версии 1.

Комплект устанавливается в `~/.codex/plugins/multi-agent-mcp/`. Перезапустите клиент, откройте чат в папке проекта и напишите «Проверь статус этого проекта через Paradev Agent Tools». Для диагностики выполните `~/.codex/plugins/multi-agent-mcp/launch --diagnose`. Для обновления запустите скрипт из нового архива и выберите свой клиент. Настройки профиля сохраняются.

#### Обновление прежней установки

Запустите установщик из нового архива и выберите свой клиент. Установщик сохраняет прежний комплект в резервной копии и переводит хуки Codex и Claude из версии 0.1.6 на постоянный `launch`. Если Codex предложит проверить обновлённые хуки, подтвердите их в интерфейсе.

## Настройки клиентов

Локальный режим установщика добавляет запись в каталог Codex `~/.agents/plugins/marketplace.json` или регистрирует сервер в пользовательской конфигурации OpenCode или Kilo. Соседние настройки и комментарии JSONC сохраняются. Уже существующий одноимённый пользовательский скилл вызывает конфликт, изменённый пользователем скилл из прежней установки сохраняется. Для OpenCode с нестандартным `OPENCODE_CONFIG` добавьте запись в этот файл через редактор и скопируйте скилл `skills/multi-agent-mcp` из установленного пакета в каталог пользовательских скиллов. Подставьте абсолютный путь к `launch` вместо примера.

OpenCode 2:

```json
{"mcp":{"servers":{"multi-agent-mcp":{"type":"local","command":["/absolute/path/to/multi-agent-mcp/launch"],"timeout":{"execution":180000}}}}}
```

OpenCode 1:

```json
{"mcp":{"multi-agent-mcp":{"type":"local","command":["/absolute/path/to/multi-agent-mcp/launch"],"timeout":180000}}}
```

Параметры MCP для Codex входят в манифест пакета. Сервер не требует npm, глобального `paradev-agent`, HTTP-порта или аккаунта MCP. Диагностика подтверждает связь с локальным хостом отдельно от проверки бинарника. В списке PID `exited` означает ESRCH, `permission-denied` означает, что песочница не дала проверить процесс. Хостом управляет приложение Paradev/Superset Desktop. Отчёт выводит путь к манифесту, PID и результат проверки процесса.

### Путь к launch для ручного подключения

Выполните [установку из Git](#установка-из-git-для-mcp-клиентов-и-хуков) с аргументами `manual --link`. Установщик покажет постоянный абсолютный путь к `launch`. Укажите его в настройках клиента как команду локального MCP stdio.

Клиент должен запускать команду в том же окружении, где работают хост Paradev и Git-проект. Файл `launch` выбирает готовый бинарник для ОС и архитектуры.

### Kilo Code и Kilo CLI

Пункт **Kilo Code / Kilo CLI** в меню `launch` подключает MCP для всех проектов. Для ручной настройки используйте `~/.config/kilo/kilo.json` или существующий `~/.config/kilo/kilo.jsonc`. Для одного проекта используйте `kilo.json` или `.kilo/kilo.json` в его корне. Добавьте запись в объект `mcp` и подставьте [абсолютный путь к launch](#путь-к-launch-для-ручного-подключения).

```json
{
  "mcp": {
    "paradev-agent-tools": {
      "type": "local",
      "command": ["/absolute/path/to/multi-agent-mcp/launch"],
      "enabled": true
    }
  }
}
```

В Kilo CLI запустите `kilo mcp list`. В расширении Kilo Code для VS Code можно также добавить сервер через **Settings → Agent Behaviour → MCP Servers**, выбрав **Local (stdio)** и указав путь к `launch`. [Документация Kilo CLI](https://kilo.ai/docs/automate/mcp/using-in-cli) · [Документация Kilo Code](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)

### Другие MCP-клиенты

Для Claude Code укажите [путь к launch](#путь-к-launch-для-ручного-подключения) и проверьте, что сервер появился в списке. [Документация Claude Code](https://code.claude.com/docs/en/mcp)

```sh
claude mcp add --transport stdio --scope user paradev-agent-tools -- "$HOME/.codex/plugins/multi-agent-mcp/launch"
claude mcp list
```

Для Gemini CLI используйте команду ниже. Проверяйте статус сервера из доверенной папки проекта. [Документация Gemini CLI](https://geminicli.com/docs/tools/mcp-server/#managing-mcp-servers-with-gemini-mcp)

```sh
gemini mcp add --transport stdio --scope user paradev-agent-tools "$HOME/.codex/plugins/multi-agent-mcp/launch"
gemini mcp list
```

В других клиентах добавьте локальный сервер с транспортом **stdio**, абсолютным путём к `launch` и пустым списком аргументов. Проверьте связь с хостом командой `"/absolute/path/to/multi-agent-mcp/launch" --diagnose`. Затем в чате попросите вызвать `status` и передать абсолютный `cwd` нужного проекта.

## Работа из чата

Путь `cwd` для статуса, слотов, создания и продолжения сессии, закрытия, коммита и уборки передаётся явно. `projects` возвращает зарегистрированные checkout и ID. Для вложенных каталогов выбирается наиболее близкий зарегистрированный worktree. Для отдельных слотов допустим путь основной копии того же проекта и точный ID цели. Результаты сессии идентифицируются точной парой `workspaceId` и `sessionId`. Если транспорт сменил ID после send/resume, используйте новый ID из результата или списка. Рабочий каталог сервера может быть где угодно.

Для подготовленного слота вызовите `session_create` с его `cwd`, `workspaceId`, ожидаемыми `branch` и `task`
и поручением в `prompt`. Если слот ещё нужен, сначала вызовите `slot_take` и передайте в запуск
возвращённые `path`, `workspace` и назначение из результата подготовки. Запуск проверяет лимит сессий,
занятость, чистоту и назначение, а `created` возвращает ID созданной сессии. Отдельный status нужен
при ошибке, неоднозначном результате или устаревшем назначении.

После уточнения проверяйте подтверждение `session_send`. Код 7 означает неопределённую доставку.
Читайте `session_journal` и сверяйте текст и время до новой отправки. У `session_wait` таймаут по умолчанию
15 секунд, продолжение использует тот же якорь. `idle` означает конец хода. Для завершения задачи проверьте
сам ответ. После `session_close` проверяйте `close` и `release`. Для `queued` используйте `close_result`
после выдачи receipt. При `partial` проверьте причину, состояние сессии и слот до следующего действия.
Preview коммитов, уборки, переноса локальных файлов и установки исполнителей включён по умолчанию.

## Покрытие команд

| CLI | MCP или настройка |
| --- | --- |
| `status`, `doctor` | `status`, `diagnose`; `projects` помогает выбрать каталог |
| `ls`, `log`, `create` | `session_list`, `session_history`, `session_create` |
| `send`, `wait`, `last` | `session_send`, `session_wait`, `session_last`; `session_journal` читает записи |
| `task complete` | `task_complete` освобождает слот после завершения задачи без закрытия чата |
| `resume`, `close`, `close --result` | `session_resume`, `session_close`, `close_result` |
| `alias`, `keep`, `forget`, `gc` | `aliases` и `session_alias`, `kept_sessions` и `session_keep`, `session_forget`, `cleanup` |
| `slot ls/create/take/prepare` | `slot_list/create/take/prepare` |
| `slot sync/sync-back/release` | `slot_sync`, `slot_sync_back`, `session_close` |
| `commit`, `commit hunks` | `commit_plan`, `commit_hunks` |
| `--help <тема>`, `install --agent` | `skills_list`, `skill_read`, `executor_install_skills` |
| Настройка исполнителя, `hook install` | `executor_install`, `executor_install_hooks` |
| `hook session-start/stop/session-end` | Именованные lifecycle handlers Codex/Claude, вызываемые исполнителем |
| `sess …`, `finish` | Канонические инструменты сессии; `finish` использует `session_close` |

Для закрытия сессии и освобождения всех её слотов используйте `session_close`.
При самозакрытии передайте `afterReply: true` и точные UUID чата и workspace из `status`.
Фоновый процесс проверит receipt в завершённом ответе этого чата, поэтому самозакрытие работает
и при отсутствии ID вызывающего чата в окружении MCP. При закрытии задачи с освобождением слота
действуют проверки проекта. Закрытие чата и освобождение слотов имеют отдельные статусы в `close_result`.
Для дополнительных слотов указывайте `ownerWorkspaceId` и `ownerSessionId` вызывающей сессии
в `slot_take` или `slot_prepare`. Результаты их освобождения доступны в `additionalSlots`.
| `--help` | Описание и JSON Schema в `tools/list` и встроенные скиллы |

## Скиллы и хуки

- **Codex как оркестратор.** Скилл `multi-agent-mcp` в плагине задаёт порядок действий из чата. Клиент запускает MCP по манифесту. Плагин не регистрирует одноимённые lifecycle hooks поверх пользовательских.
- **OpenCode как оркестратор.** Setup подключает MCP и пользовательский скилл. Доступные в OpenCode V2 серверные хуки и события, в частности `session.idle`, описывают собственные ходы OpenCode. Плагин получает состояние и факт закрытия исполнителя через Paradev. Хуки оркестратора для этого не нужны.
- **Исполнитель Codex/Claude.** По явному поручению выполните `executor_install` сначала в режиме предпросмотра, затем с `dryRun: false`. Плагин устанавливает роутер, сохраняет личные дополнения и добавляет именованные `SessionStart`, `Stop`, `SessionEnd` и, в Codex, `UserPromptSubmit`. О проверке вручную открытого слота и показе вопроса в чате см. [руководство CLI](cli.md#резерв-и-освобождение-в-paradev-host-service). Эти хуки сохраняют контекст и результат и могут запланировать release после завершения транспорта. Codex должен доверять текущим определениям хуков. Если хост Codex показывает запрос, подтвердите их в интерфейсе доверия хукам. Терминальный интерфейс Codex показывает их по `/hooks`; внутри чата Paradev её нет. Обычный внешний close через MCP использует штатную проверку закрытия и release независимо от установки этих хуков.

## Сборка и источники форматов

GitHub Actions проверяет сборку и установку на macOS Apple Silicon и Linux x64. При push в `main` проверенные архивы доступны в **Artifacts**. Изменение версии в `mcp/plugin.json` на `main` автоматически запускает публикацию. Workflow прикрепляет `paradev-agent-tools.tar.gz` и `paradev-agent-tools-clients.tar.gz` к релизу, обновляет ветку `distribution` и публикует черновик как последний релиз. Совпадающий тег `vX.Y.Z` или ручной запуск на `main` также запускают публикацию. Повторный запуск того же коммита добавляет недостающие архивы. [GitHub Actions](https://github.com/burningyouth/paradev-agent-tools/actions/workflows/build.yml) · [GitHub Releases](https://github.com/burningyouth/paradev-agent-tools/releases)

`go run ./cmd/pack` создаёт `dist/paradev-agent-tools-<версия>.tar.gz` с обоими скриптами установки. Передайте `-clients /path/to/clients.tar.gz` для дополнительного снимка ветки `distribution`. Архивы используют одинаковый комплект CLI и MCP.

`go test ./...` проверяет CLI и MCP в изолированных Git-репозиториях с заглушками Paradev. CI также проверяет оба распакованных архива и запускает тест установки в Linux без Node.js, npm и Go. Для локальной проверки распакованных архивов подставьте их абсолютные пути в команду.

```sh
TEST_MCP_PACKAGE="/path/to/Paradev Agent Tools/paradev-agent-tools" \
TEST_MCP_CLIENTS="/path/to/extracted-clients" \
  go test -count=1 -run '^TestRelease' ./cmd/pack
```

- [Codex · личный локальный каталог и формат плагина](https://developers.openai.com/plugins/build/plugins)
- [Codex · запуск локального stdio](https://developers.openai.com/plugins/deploy/desktop-only)
- [OpenCode · MCP v2](https://opencode.ai/docs/mcp-servers/)
- [OpenCode · переход с v1](https://opencode.ai/docs/migrate-v1/)
- [OpenCode · серверный lifecycle](https://opencode.ai/docs/build/plugins/server/)
- [OpenCode · обнаружение скиллов](https://opencode.ai/docs/skills/)
- [MCP · транспорт stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
