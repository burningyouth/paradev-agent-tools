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

**Обычный OpenCode 2.3.1 и новее.** Добавьте пакет.

```sh
opencode plugin add 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'
```

В OpenCode Desktop обновите пакет через **Settings → Extensions → Check for updates → Update**. В терминале выполните `opencode plugin update 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'`. Пакет регистрирует MCP-сервер `paradev-agent-tools` и сохраняет параметры одноимённой записи, созданной установщиком. [Документация OpenCode](https://opencode.ai/docs/plugins/) · [Журнал изменений OpenCode](https://opencode.ai/changelog)

#### Переход на маркетплейс burningyouth

Если `codex plugin marketplace list` показывает старый Git-маркетплейс `paradev-agent-tools`, удалите его регистрацию и снова добавьте тот же репозиторий.

```sh
codex plugin marketplace remove paradev-agent-tools
codex plugin marketplace add burningyouth/paradev-agent-tools --ref distribution
codex plugin add paradev-agent-tools@burningyouth
```

Перезапустите Codex и проверьте `paradev-agent-tools@burningyouth` в новом чате. Затем отключите прежнюю установку в **Plugins**.

#### Обновление до версии 0.2.3

В версии 0.2.3 сервер, скилл и каталог локальной установки называются `paradev-agent-tools`. Если клиент подключался вручную, перенесите пользовательские параметры в запись с новым именем, укажите новый путь к `launch` и отключите предыдущую запись. Для локального маркетплейса Codex обновите путь в `~/.agents/plugins/marketplace.json` перед повторной установкой.

Если хуки или команда `paradev-agent` ссылаются на предыдущий каталог, установите пакет [из Git](#установка-из-git-для-mcp-клиентов-и-хуков) или [из архива](#установка-из-zip). Перенесите прежнюю ссылку `~/.local/bin/paradev-agent` в резерв и подключите CLI из нового каталога. Переустановите хуки, которые указывают на прежний каталог. Личные инструкции находятся в отдельном профиле.

### OpenCode 2 внутри Paradev

Paradev запускает OpenCode со своим `OPENCODE_CONFIG_DIR`. В ZIP-установщике выберите **OpenCode внутри Paradev (workspace)** или запустите из распакованной папки.

```sh
sh Install.sh opencode-paradev --workspace /абсолютный/путь/к/worktree
```

По умолчанию используется профиль `~/.paradev/hooks/opencode` (или `$SUPERSET_HOME_DIR/hooks/opencode`). Для другого профиля передайте `--profile /абсолютный/путь` к его `OPENCODE_CONFIG_DIR`. Установщик проверит унаследованные настройки и добавит MCP и скиллы только в выбранный worktree. Запись другого источника требует проверить фактическое подключение в клиенте.

Для обновления ZIP используйте чат OpenCode в этом workspace или постоянный launcher из отчёта установки. Для нативного каталога проверьте точный пакет через `opencode plugin list` в том же профиле и рабочей папке. Выполните команду обновления каталога из [README](../README.md#обновление) только если команда видит пакет в профиле Paradev. Обычный OpenCode может использовать другой профиль. Для проверки вызовите `plugin_source` в новом чате. `opencode mcp list` с тем же профилем может вернуть пустой результат на первом запросе при запуске OpenCode 2. [Отчёт OpenCode](https://github.com/anomalyco/opencode/issues/64941)

### Установка из Git для MCP-клиентов и хуков

Здесь описано подключение готового пакета из ветки `distribution`. Для полной рабочей копии с исходниками см. [локальную установку из клона для разработки](../README.md#разработчикам-обычный-git-clone-исходников).

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

Установщик связывает `~/.codex/plugins/paradev-agent-tools/` с клоном. Kilo и OpenCode 1 получают настройку MCP сразу. В Claude Code, Gemini CLI и других клиентах один раз [зарегистрируйте сервер](#другие-mcp-клиенты). При замене архива в этом каталоге на ссылку установщик создаёт резервную копию.

**Обновление.** Закройте клиент, выполните команду ниже и снова откройте клиент. Он загрузит новый сервер из клона. Хуки используют новый код при следующем запуске. Повторная установка и регистрация MCP не нужны.

```sh
git -C "$HOME/paradev-agent-tools" pull --ff-only
```

Для диагностики выполните `"$HOME/.codex/plugins/paradev-agent-tools/launch" --diagnose`.

### Установка из ZIP

Скачайте ZIP для вашей платформы из [GitHub Releases](https://github.com/burningyouth/paradev-agent-tools/releases/latest). До распаковки сравните вывод `shasum -a 256 ПАКЕТ.zip` (или `sha256sum ПАКЕТ.zip`) с SHA-256 этого файла в релизе. Первый запуск сохраняет комплект в `~/.local/share/paradev-agent-tools`. Один домашний каталог может использовать комплект из нескольких профилей.

```sh
sh Install.sh codex
sh Install.sh opencode-auto    # или opencode / opencode-v1
sh Install.sh opencode-paradev --workspace /path/to/worktree
sh Install.sh kilo
sh Install.sh manual           # CLI и ручное подключение MCP stdio
```

Codex регистрирует локальный MCP в выбранном `CODEX_HOME` и добавляет ссылки на скиллы в этот профиль. Обычный OpenCode использует `OPENCODE_CONFIG_DIR` или XDG-профиль. Если конфиг задан через `OPENCODE_CONFIG` или `OPENCODE_CONFIG_CONTENT`, выберите `manual` и добавьте MCP в активный конфиг. Скилл обновления также доступен через `skill_read`.

Из этой папки можно удалить скачанный ZIP и распакованные файлы после проверки установки. Для работы с проектами нужны Git и локальный Paradev Host Service. В WSL2 используйте Linux-клиент и Linux ZIP внутри дистрибутива.

### Обновление и откат ZIP

```sh
"$HOME/.local/share/paradev-agent-tools/launch" --agent-cli update check
```

Команда покажет текущую и доступную версии, абсолютный путь и команду с подтверждаемыми версиями и SHA-256. `update apply FROM TO SHA256` сверяет последнюю версию и контрольную сумму повторно. `update rollback FROM TO` переключается на точную предыдущую версию без сети. При переключении launcher остаётся на месте, а запущенный MCP продолжает работать на своей версии до нового запуска. Проверяйте фактически загруженную версию через `plugin_source` в свежем входе.

Старый TAR, Git-клон и клиентские каталоги остаются отдельными источниками. Если переходите со старого TAR на ZIP, найдите место прежней регистрации и отключите только её в выбранном клиенте перед первой установкой ZIP. Профили, история и личные правила хранятся отдельно. Для связанного клона ветки `distribution` действует прежнее [обновление клона](#установка-из-git-для-mcp-клиентов-и-хуков).

## Настройки клиентов

Локальный режим старого TAR добавляет запись в каталог Codex `~/.agents/plugins/marketplace.json` или регистрирует сервер в пользовательской конфигурации OpenCode или Kilo. Соседние настройки и комментарии JSONC сохраняются. Уже существующий одноимённый пользовательский скилл вызывает конфликт, изменённый пользователем скилл из прежней установки сохраняется. Для OpenCode с нестандартным `OPENCODE_CONFIG` добавьте запись в этот файл через редактор и скопируйте скилл `skills/paradev-agent-tools` из установленного пакета в каталог пользовательских скиллов. Подставьте абсолютный путь к `launch` вместо примера.

OpenCode 2:

```json
{"mcp":{"servers":{"paradev-agent-tools":{"type":"local","command":["/absolute/path/to/paradev-agent-tools/launch"],"timeout":{"execution":180000}}}}}
```

OpenCode 1:

```json
{"mcp":{"paradev-agent-tools":{"type":"local","command":["/absolute/path/to/paradev-agent-tools/launch"],"timeout":180000}}}
```

Параметры MCP для Codex входят в манифест пакета. Сервер не требует npm, глобального `paradev-agent`, HTTP-порта или аккаунта MCP. Диагностика подтверждает связь с локальным хостом отдельно от проверки бинарника. В списке PID `exited` означает ESRCH, `permission-denied` означает, что песочница не дала проверить процесс. Хостом управляет приложение Paradev/Superset Desktop. Отчёт выводит путь к манифесту, PID и результат проверки процесса.

### Путь к launch для ручного подключения

Укажите абсолютный путь к `launch` как команду локального MCP stdio. Для ZIP его выводит установщик в режиме `manual`. Для локальной сборки возьмите `dist/dev/plugins/paradev-agent-tools/launch` из полного клона. Для связанного готового пакета путь выводит [установщик ветки `distribution`](#установка-из-git-для-mcp-клиентов-и-хуков) в режиме `manual --link`.

Клиент должен запускать команду в том же окружении, где работают хост Paradev и Git-проект. Файл `launch` выбирает готовый бинарник для ОС и архитектуры.

### Kilo Code и Kilo CLI

Пункт **Kilo Code / Kilo CLI** в меню `launch` подключает MCP для всех проектов. Для ручной настройки используйте `~/.config/kilo/kilo.json` или существующий `~/.config/kilo/kilo.jsonc`. Для одного проекта используйте `kilo.json` или `.kilo/kilo.json` в его корне. Добавьте запись в объект `mcp` и подставьте [абсолютный путь к launch](#путь-к-launch-для-ручного-подключения).

```json
{
  "mcp": {
    "paradev-agent-tools": {
      "type": "local",
      "command": ["/absolute/path/to/paradev-agent-tools/launch"],
      "enabled": true
    }
  }
}
```

В Kilo CLI запустите `kilo mcp list`. В расширении Kilo Code для VS Code можно также добавить сервер через **Settings → Agent Behaviour → MCP Servers**, выбрав **Local (stdio)** и указав путь к `launch`. [Документация Kilo CLI](https://kilo.ai/docs/automate/mcp/using-in-cli) · [Документация Kilo Code](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)

### Другие MCP-клиенты

Для Claude Code укажите [путь к launch](#путь-к-launch-для-ручного-подключения) и проверьте, что сервер появился в списке. [Документация Claude Code](https://code.claude.com/docs/en/mcp)

```sh
claude mcp add --transport stdio --scope user paradev-agent-tools -- "$HOME/.codex/plugins/paradev-agent-tools/launch"
claude mcp list
```

Для Gemini CLI используйте команду ниже. Проверяйте статус сервера из доверенной папки проекта. [Документация Gemini CLI](https://geminicli.com/docs/tools/mcp-server/#managing-mcp-servers-with-gemini-mcp)

```sh
gemini mcp add --transport stdio --scope user paradev-agent-tools "$HOME/.codex/plugins/paradev-agent-tools/launch"
gemini mcp list
```

В других клиентах добавьте локальный сервер с транспортом **stdio**, абсолютным путём к `launch` и пустым списком аргументов. Проверьте связь с хостом командой `"/absolute/path/to/paradev-agent-tools/launch" --diagnose`. Затем в чате попросите вызвать `status` и передать абсолютный `cwd` нужного проекта.

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
| `update source`, `update check` | `plugin_source` с необязательным `check` |
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

- **Codex как оркестратор.** Скилл `paradev-agent-tools` в плагине задаёт порядок действий из чата. Клиент запускает MCP по манифесту. Плагин не регистрирует одноимённые lifecycle hooks поверх пользовательских.
- **OpenCode как оркестратор.** Setup подключает MCP и пользовательский скилл. Доступные в OpenCode V2 серверные хуки и события, в частности `session.idle`, описывают собственные ходы OpenCode. Плагин получает состояние и факт закрытия исполнителя через Paradev. Хуки оркестратора для этого не нужны.
- **Исполнитель Codex/Claude.** По явному поручению выполните `executor_install` сначала в режиме предпросмотра, затем с `dryRun: false`. Плагин устанавливает роутер, сохраняет личные дополнения и добавляет именованные `SessionStart`, `Stop`, `SessionEnd` и, в Codex, `UserPromptSubmit`. О проверке вручную открытого слота и показе вопроса в чате см. [руководство CLI](cli.md#резерв-и-освобождение-в-paradev-host-service). Эти хуки сохраняют контекст и результат и могут запланировать release после завершения транспорта. Codex должен доверять текущим определениям хуков. Если хост Codex показывает запрос, подтвердите их в интерфейсе доверия хукам. Терминальный интерфейс Codex показывает их по `/hooks`; внутри чата Paradev её нет. Обычный внешний close через MCP использует штатную проверку закрытия и release независимо от установки этих хуков.

## Сборка и источники форматов

GitHub Actions проверяет сборку и установку на macOS Apple Silicon и Linux x64. При push в `main` проверенные архивы доступны в **Artifacts**. Изменение версии в `mcp/plugin.json` на `main` автоматически запускает публикацию. Workflow прикрепляет четыре ZIP по платформам, `paradev-agent-tools.tar.gz` и `paradev-agent-tools-clients.tar.gz` к релизу, обновляет ветку `distribution` и публикует черновик как последний релиз. Совпадающий тег `vX.Y.Z` или ручной запуск на `main` также запускают публикацию. Повторный запуск того же коммита добавляет недостающие архивы. [GitHub Actions](https://github.com/burningyouth/paradev-agent-tools/actions/workflows/build.yml) · [GitHub Releases](https://github.com/burningyouth/paradev-agent-tools/releases)

`go run ./cmd/pack -dev` готовит локальный плагин в `dist/dev` для текущей платформы.

`go run ./cmd/pack` создаёт `dist/paradev-agent-tools-<версия>.tar.gz` с обоими скриптами установки. Передайте `-zip-dir dist/zip` для четырёх ZIP или `-clients /path/to/clients.tar.gz` для дополнительного снимка ветки `distribution`. Архивы используют одинаковый комплект CLI и MCP.

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
