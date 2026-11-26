# Paradev Agent Tools

Paradev Agent Tools помогает вести несколько задач из одного чата. Агент может выделить исполнителю отдельную рабочую копию Git, запустить в ней Codex или Claude Code, передать уточнение и проверить результат. Когда работа закончена, пакет помогает сохранить историю и освободить слот для следующей задачи.

## Работа из чата

| Что написать | Что сделает агент |
| --- | --- |
| «Возьми отдельный слот и поручи Codex разобраться, почему пустой список показывает ошибку». | Проверит правила проекта, подготовит отдельный Git worktree и запустит исполнителя с поручением. |
| «Уточни исполнителю, что пустой список должен показывать подсказку, и дождись ответа». | Отправит уточнение в ту же сессию и покажет ответ или вопрос исполнителя. |
| «Покажи, что уже сделано и какие файлы изменились». | Прочитает ответы исполнителя и сверит состояние его рабочей копии. |
| «Подготовь коммит только из правок пустого состояния». | Покажет точный состав коммита перед применением. |
| «Сохрани итог и закрой сессию». | Сохранит историю для продолжения и проверит освобождение всех её слотов. |
| «Покажи, какие завершённые сессии можно убрать». | Покажет план уборки и отметит, что мешает освободить занятые слоты. |

### Что входит в пакет

- **Инструменты MCP** дают агенту доступ к статусу проекта, слотам, сессиям, журналам и планам коммитов. [Список инструментов](docs/paradev-agent-tools.md#покрытие-команд)
- **Скиллы** описывают порядок работы с сессиями, слотами и локальными файлами, делегирование, коммиты по плану, уборку и диагностику. Скилл `paradev-agent-tools` помогает основному чату выбирать инструменты, а роутер `agent-cli` направляет исполнителя к нужному процессу и правилам проекта. [Список скиллов](docs/skills.md#встроенные-процессы-для-агентов)
- **Хуки исполнителей** сохраняют контекст при старте (`SessionStart`) и последний результат после ответа (`Stop`). При завершении сессии `SessionEnd` может запустить проверяемое освобождение слота. В Codex `UserPromptSubmit` проверяет, принадлежит ли слот текущему чату. Хуки подключаются при настройке исполнителя через `executor_install`. [Подключение скиллов и хуков](docs/paradev-agent-tools.md#скиллы-и-хуки)

## Установка

Пакет работает на macOS и Linux на arm64 и amd64. Для работы с проектами нужны Git и локальный хост Paradev.

### Пользователям: готовый ZIP по ОС

Выберите ZIP только при первой установке. Если архитектура неизвестна, выполните `uname -m` в терминале.

| Среда | Файл |
| --- | --- |
| macOS Apple Silicon (`arm64`) | [darwin-arm64](https://github.com/burningyouth/paradev-agent-tools/releases/latest/download/paradev-agent-tools-darwin-arm64.zip) |
| macOS Intel (`x86_64`) | [darwin-amd64](https://github.com/burningyouth/paradev-agent-tools/releases/latest/download/paradev-agent-tools-darwin-amd64.zip) |
| Linux `aarch64` или `arm64` | [linux-arm64](https://github.com/burningyouth/paradev-agent-tools/releases/latest/download/paradev-agent-tools-linux-arm64.zip) |
| Linux `x86_64` | [linux-amd64](https://github.com/burningyouth/paradev-agent-tools/releases/latest/download/paradev-agent-tools-linux-amd64.zip) |

Распакуйте скачанный ZIP, откройте его папку в терминале и выполните `sh Install.sh`. Выберите Codex, обычный OpenCode 1/2, OpenCode внутри Paradev, Kilo или ручное подключение MCP/CLI. Установщик выдаст постоянный путь к `launch`. Для ручного MCP укажите этот путь как локальную команду `stdio`. Для CLI используйте соседний `paradev-agent` или выполните `launch --agent-cli install` с выданным абсолютным путём.

В **Windows с WSL2** выберите Linux ZIP для архитектуры дистрибутива и запустите установщик в WSL2. Клиент, MCP и необходимые зависимости должны быть доступны в этой же среде. Нативного пакета Windows нет.

После подключения откройте новый чат и попросите вызвать `plugin_source`. Для ZIP ответ покажет `source: zip` и путь установленного пакета.

[Проверка ZIP, команды установки и настройка профилей](docs/paradev-agent-tools.md#установка-из-zip)

### Разработчикам: обычный git clone исходников

Нужны Git и Go 1.26+. Скрипт соберёт локальный пакет в `dist/dev` и предложит выбрать клиент.

```sh
git clone https://github.com/burningyouth/paradev-agent-tools.git
cd paradev-agent-tools
./install.sh
```

| Клиент | Команда без меню |
| --- | --- |
| Codex | `./install.sh codex` |
| OpenCode | `./install.sh opencode-auto`, либо `./install.sh opencode` для версии 2 и `./install.sh opencode-v1` для версии 1 |
| OpenCode внутри Paradev | `./install.sh opencode-paradev --workspace /path/to/worktree` |
| Kilo | `./install.sh kilo` |
| Другой MCP-клиент | `./install.sh manual` выводит абсолютный путь к команде MCP stdio |

Codex установит плагин из локального маркетплейса `paradev-dev`. OpenCode и Kilo добавят локальный сервер MCP. Установщик OpenCode также подключит скиллы из `dist/dev`. Для OpenCode внутри Paradev настройки попадут в `.opencode/opencode.jsonc` выбранного worktree. Если у workspace нестандартный профиль OpenCode, передайте `--profile /path/to/profile`.

Для проверки рядом с релизной установкой используйте отдельный профиль. Перезапустите клиент, откройте новый чат и попросите вызвать `plugin_source`. В Codex путь должен вести в кеш маркетплейса `paradev-dev`, в остальных клиентах — в `dist/dev` вашего клона. [Настройки других MCP-клиентов](docs/paradev-agent-tools.md#другие-mcp-клиенты)

## Каталоги клиентов

В Codex доступен каталог `burningyouth`, в обычном OpenCode 2 — пакет из ветки `distribution`. Если плагин подключён через каталог, обновляйте его командой своего клиента. [Команды подключения каталогов](docs/paradev-agent-tools.md#штатные-пакеты-codex-и-opencode-2)

## Обновление

### ZIP и каталоги клиента

В новом чате напишите **«Обнови Paradev Agent Tools»**. Скилл проверит, какую версию и источник загрузил клиент, сверит GitHub Releases и покажет результат. Перед изменением он попросит подтвердить точный переход. Если источник нельзя подтвердить, скилл покажет обнаруженные варианты.

| Подключение | Как обновлять |
| --- | --- |
| Codex из каталога `burningyouth` | `codex plugin marketplace upgrade burningyouth` из профиля клиента. Версия в `codex plugin list --marketplace burningyouth --json`. |
| Обычный OpenCode 2 из каталога | `opencode plugin update 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'` из того же профиля. |
| Codex, обычный OpenCode 1/2 или Kilo из ZIP | Попросите обновить в чате или используйте `launch --agent-cli update check` по пути установщика. |
| OpenCode внутри Paradev | Для ZIP — попросите обновить в чате этого workspace. Для каталога — используйте механизм OpenCode 2 только в том же профиле Paradev. [Как определить профиль](docs/paradev-agent-tools.md#opencode-2-внутри-paradev) |
| CLI или ручной MCP из ZIP | `paradev-agent update check` или `launch --agent-cli update check`. Вывод содержит точную команду обновления и доступный откат. |

ZIP-updater сам скачивает и проверяет архив для вашей платформы. Конфигурация клиента продолжает использовать прежний путь. Перезапустите клиент или MCP и в свежем чате проверьте версию через `plugin_source`.

[Откат ZIP и переход со старого TAR](docs/paradev-agent-tools.md#обновление-и-откат-zip) · [Документация Codex](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli) · [Документация OpenCode](https://opencode.ai/docs/plugins/#manage)

### Локальная сборка из исходников

Закройте тестовый клиент и выполните из корня того же клона.

```sh
git pull --ff-only && ./install.sh
```

Выберите тот же клиент или передайте его в команде. Скрипт Codex обновит копию плагина в кеше. Для клиентов, уже подключённых к `dist/dev`, можно выполнить только сборку командой `go run ./cmd/pack -dev`. Перезапустите клиент и проверьте путь через `plugin_source` в новом чате.

## Удаление плагина

**Codex**

```sh
codex plugin remove paradev-agent-tools@burningyouth
```

Для сборки из исходников используйте `codex plugin remove paradev-agent-tools@paradev-dev`. Для установки из другого маркетплейса выберите точный идентификатор в **Plugins** или в выводе `codex plugin list`. При локальной установке из архива можно также убрать запись плагина из `~/.agents/plugins/marketplace.json`.

**OpenCode 2**

```sh
opencode plugin remove 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'
```

Если плагин добавляли вручную, уберите его из массива `plugins` в том `opencode.json(c)`, где он подключён. [Документация OpenCode](https://opencode.ai/docs/plugins/#manage)

**Подключение через MCP**

1. Удалите в настройках клиента запись MCP `paradev-agent-tools`. В OpenCode 2 она находится в `mcp.servers`, в OpenCode 1 и Kilo — в `mcp`. В Codex используйте `codex mcp remove paradev-agent-tools` в нужном профиле. Удалите ссылки на скиллы `paradev-agent-tools` и `paradev-agent-update`, ведущие в удаляемый пакет или `dist/dev`.
2. Если подключали хуки, уберите только команды `paradev-agent hook` или `launch --agent-cli hook` из `~/.codex/hooks.json` и `~/.claude/settings.json`. Если настраивали цикл слотов в Paradev Host Service, уберите привязку к этому пакету из `state/chat-slots.json` перед удалением `launch`.
3. Для ZIP удалите `~/.local/share/paradev-agent-tools`, если пакет больше не используется другими профилями. Для старого TAR или связанного клона удалите каталог или ссылку `~/.codex/plugins/paradev-agent-tools`. Удалите ссылку `~/.local/bin/paradev-agent`, если она указывает на удалённый пакет. Сохраните `~/.agent-cli` (или `$AGENT_CLI_HOME`) с историей сессий и `references/personal.md` с личными правилами роутера `agent-cli`.

Перезапустите клиент и проверьте в новом чате, что инструменты плагина исчезли.

## Самостоятельный CLI

Из установленного ZIP можно добавить `paradev-agent` в `~/.local/bin`.

```sh
"$HOME/.local/share/paradev-agent-tools/launch" --agent-cli install
export PATH="$HOME/.local/bin:$PATH"
paradev-agent --help
```

Из исходников CLI собирается командой `go install ./cmd/paradev-agent` из корня репозитория. Для сборки требуется Go 1.26+.

Из папки проекта в Paradev запустите `paradev-agent status`, чтобы увидеть состояние workspace, или `paradev-agent ls`, чтобы перечислить живые сессии. Для скриптов есть `--json`. Команда `paradev-agent --help slots` открывает инструкцию по слотам без подключения к Paradev. [Руководство по CLI](docs/cli.md) · [Справочник команд](docs/commands.md) · [Конфигурация проекта](docs/cli.md#agent-clijson)

Для запуска из скрипта команда `paradev-agent create --project P --branch B --prompt-file F` использует первый свободный слот. Если все слоты заняты, команда сначала спрашивает согласие на новый. [Запуск задачи в слоте](docs/cli.md#запуск-задачи-в-слоте)

Управление Pen подключается отдельно. [pen-cli](https://github.com/burningyouth/pen-cli)

## Разработка

Для проверок используйте `go test ./...` и `go vet ./...`. Команда `go run ./cmd/pack -zip-dir dist/zip` собирает релизные ZIP и общий TAR. [Сборка и форматы поставки](docs/paradev-agent-tools.md#сборка-и-источники-форматов)

В [шаблоне плагина](examples/plugin-kit/README.md) один Go-сборщик готовит пакеты для Codex и OpenCode 2. В шаблоне есть примеры со скиллом и локальным MCP, а также проверка готового архива без Node.js.

## Лицензия

[MIT](LICENSE)
