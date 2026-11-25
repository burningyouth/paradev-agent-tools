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

Пакет содержит готовые исполняемые файлы для macOS и Linux на arm64 и amd64. Для установки и работы плагина достаточно клиента. Для работы с проектами нужны Git и локальный хост Paradev.

### 1. Установка командой клиента

**Codex**

```sh
codex plugin marketplace add burningyouth/paradev-agent-tools --ref distribution
codex plugin add paradev-agent-tools@burningyouth
```

**OpenCode 2**

```sh
opencode plugin add 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'
```

- **Обновление Codex** — `codex plugin marketplace upgrade burningyouth` обновляет снимок маркетплейса. Чтобы проверить версию установленного плагина, выполните `codex plugin list --marketplace burningyouth --json`. После обновления перезапустите клиент и проверьте инструменты в новом чате. [Документация Codex](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)
- **Обновление OpenCode 2** — `opencode plugin update 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'`.

Если Git-маркетплейс Codex уже подключён под именем `paradev-agent-tools`, сначала [перейдите на новое имя](docs/paradev-agent-tools.md#переход-на-маркетплейс-burningyouth). При переходе с локальной версии Codex отключите прежний плагин в **Plugins** после проверки новой установки.

### 2. Установка из Git-клона

**Шаг 1. Клонируйте репозиторий.** Готовый пакет находится в ветке `distribution`.

```sh
git clone --branch distribution --single-branch https://github.com/burningyouth/paradev-agent-tools.git "$HOME/paradev-agent-tools"
```

**Шаг 2. Подключите клиент.** Замените `CLIENT` в команде на `kilo` для Kilo, `opencode-v1` для OpenCode 1 или `manual` для Claude Code, Gemini CLI, другого MCP-клиента или хуков.

```sh
"$HOME/paradev-agent-tools/plugins/paradev-agent-tools/launch" --install CLIENT --link
```

[Команды для каждого клиента](docs/paradev-agent-tools.md#установка-из-git-для-mcp-клиентов-и-хуков)

Для обновления закройте клиент, выполните команду и снова откройте клиент. Он загрузит новую версию из клона. Установщик запускается один раз.

```sh
git -C "$HOME/paradev-agent-tools" pull --ff-only
```

После установки запустите Paradev, откройте Git-проект, перезапустите клиент и напишите в новом чате **«Проверь статус этого проекта через Paradev Agent Tools»**.

Для установки без доступа к GitHub используйте заранее скачанный [архив для macOS и Linux](https://github.com/burningyouth/paradev-agent-tools/releases/latest/download/paradev-agent-tools.tar.gz). [Режим установки из архива](docs/paradev-agent-tools.md#установка-из-архива)

## Удаление плагина

**Codex**

```sh
codex plugin remove paradev-agent-tools@burningyouth
```

Для установки из другого маркетплейса выберите точный идентификатор в **Plugins** или в выводе `codex plugin list`. При локальной установке из архива можно также убрать запись плагина из `~/.agents/plugins/marketplace.json`.

**OpenCode 2**

```sh
opencode plugin remove 'git+https://github.com/burningyouth/paradev-agent-tools.git#distribution'
```

Если плагин добавляли вручную, уберите его из массива `plugins` в том `opencode.json(c)`, где он подключён. [Документация OpenCode](https://opencode.ai/docs/plugins/#manage)

**Установка из Git-клона, архива или ручная настройка MCP**

1. Удалите в настройках клиента запись MCP `paradev-agent-tools`. В OpenCode 1 и Kilo это запись в объекте `mcp`. Если установщик добавил отдельный скилл `paradev-agent-tools` в OpenCode, удалите и его.
2. Если подключали хуки, уберите только команды `paradev-agent hook` или `launch --agent-cli hook` из `~/.codex/hooks.json` и `~/.claude/settings.json`. Если настраивали цикл слотов в Paradev Host Service, уберите привязку к этому пакету из `state/chat-slots.json` перед удалением `launch`.
3. Если пакет и CLI больше не нужны, удалите каталог или ссылку `~/.codex/plugins/paradev-agent-tools` и ссылку `~/.local/bin/paradev-agent`, если она указывает на этот пакет. Сохраните `~/.agent-cli` (или `$AGENT_CLI_HOME`) с историей сессий и `references/personal.md` с личными правилами роутера `agent-cli`.

Перезапустите клиент и проверьте в новом чате, что инструменты плагина исчезли.

## Самостоятельный CLI

Из установленного пакета можно добавить `paradev-agent` в `~/.local/bin`.

```sh
"$HOME/.codex/plugins/paradev-agent-tools/launch" --agent-cli install
export PATH="$HOME/.local/bin:$PATH"
paradev-agent --help
```

Из исходников CLI собирается командой `go install ./cmd/paradev-agent` из корня репозитория. Для сборки требуется Go 1.26+.

Из папки проекта в Paradev запустите `paradev-agent status`, чтобы увидеть состояние workspace, или `paradev-agent ls`, чтобы перечислить живые сессии. Для скриптов есть `--json`. Команда `paradev-agent --help slots` открывает инструкцию по слотам без подключения к Paradev. [Руководство по CLI](docs/cli.md) · [Справочник команд](docs/commands.md) · [Конфигурация проекта](docs/cli.md#agent-clijson)

Для запуска из скрипта команда `paradev-agent create --project P --branch B --prompt-file F` использует первый свободный слот. Если все слоты заняты, команда сначала спрашивает согласие на новый. [Запуск задачи в слоте](docs/cli.md#запуск-задачи-в-слоте)

Управление Pen подключается отдельно. [pen-cli](https://github.com/burningyouth/pen-cli)

## Разработка

Для проверки выполните `go test ./...` и `go vet ./...`. Команда `go run ./cmd/pack` собирает общий архив для macOS и Linux. [Сборка и форматы поставки](docs/paradev-agent-tools.md#сборка-и-источники-форматов)

Обновите версию в `mcp/plugin.json`. После попадания изменения в `main` GitHub Actions проверит сборку, опубликует релиз с готовыми архивами и обновит пакеты Codex и OpenCode 2. [Build Paradev Agent Tools](https://github.com/burningyouth/paradev-agent-tools/actions/workflows/build.yml)

В [шаблоне плагина](examples/plugin-kit/README.md) один Go-сборщик готовит пакеты для Codex и OpenCode 2. В шаблоне есть примеры со скиллом и локальным MCP, а также проверка готового архива без Node.js.

## Лицензия

[MIT](LICENSE)
