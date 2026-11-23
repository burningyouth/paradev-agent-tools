# Paradev Agent Tools

Инструменты для управления рабочими слотами и сессиями Paradev из чата. Установщик подключает Codex, OpenCode и Kilo. Claude Code, Gemini CLI и другие клиенты подключаются к тому же серверу по MCP stdio. Можно выделить слот, поручить задачу исполнителю Codex или Claude, передать уточнение и проверить результат.

## Установка

Для Codex и OpenCode 2 доступны [штатная установка и обновление](docs/multi-agent-mcp.md#штатные-пакеты-codex-и-opencode-2). Общий архив подходит также для OpenCode 1, Kilo и других MCP-клиентов.

1. Скачайте и распакуйте общий архив `paradev-agent-tools-<версия>.tar.gz`. Выпуски доступны в GitHub Releases, сборки из `main` — в **Artifacts** на странице запуска Actions. [GitHub Releases](https://github.com/burningyouth/paradev-agent-tools/releases) · [GitHub Actions](https://github.com/burningyouth/paradev-agent-tools/actions/workflows/build.yml)

2. Убедитесь, что Node.js LTS версии 22 или новее доступен установщику в `PATH`. На macOS откройте `Install.command`, на Linux запустите `./Install.sh`. Выберите клиент. Установщик сохранит абсолютный путь к Node.js для запусков из графического клиента. Для Claude Code, Gemini CLI и других клиентов пункт **Другой MCP-клиент** покажет постоянный путь к серверу. [Скачать Node.js](https://nodejs.org/en/download) · [Команды и пути](docs/multi-agent-mcp.md#другие-mcp-клиенты)
3. Запустите Paradev, откройте Git-проект, перезапустите клиент и напишите в новом чате **«Проверь статус этого проекта через Paradev Agent Tools»**. Агент покажет рабочее пространство, ветку и состояние слота.

Для обновления распакуйте новый архив и повторите установку. [Обновление, WSL2 и диагностика](docs/multi-agent-mcp.md)

## Работа из чата

| Что нужно | Что написать |
| --- | --- |
| Делегировать задачу | «Возьми отдельный слот и запусти Codex для этой задачи». |
| Уточнить поручение | «Передай в эту сессию уточнение и дождись ответа». |
| Получить результат | «Покажи последние ответы и изменения по этой задаче». |
| Завершить работу | «Сохрани итог, закрой сессию и проверь освобождение слота». |
| Проверить уборку | «Покажи, какие завершённые сессии и слоты можно освободить». |

Агент подбирает инструменты и связывает действия с конкретной сессией. Для коммитов и уборки плагин показывает план перед применением. Проверить соединение с хостом можно через `./paradev-agent-tools/launch --diagnose` из распакованной папки. [Рабочие сценарии и инструменты плагина](docs/multi-agent-mcp.md#работа-из-чата)

Для запуска из скрипта без выбранного workspace команда `paradev-agent create --project P --branch B --prompt-file F` использует первый свободный слот. Если все слоты заняты, команда сначала спрашивает согласие на новый. Вручную открытый чат Codex проверяет свой слот через хук. [Запуск задачи в слоте](docs/cli.md#запуск-задачи-в-слоте)

## Самостоятельный CLI

Для терминала и скриптов можно установить `paradev-agent` из исходников. Нужен Node.js 22 или новее.

```sh
git clone https://github.com/burningyouth/paradev-agent-tools.git
cd paradev-agent-tools
node bin/agent.js install
export PATH="$HOME/.local/bin:$PATH"
paradev-agent --help
```

Из папки проекта в Paradev запустите `paradev-agent status`, чтобы увидеть состояние workspace, или `paradev-agent ls`, чтобы перечислить живые сессии. Для скриптов есть `--json`. Команда `paradev-agent --help slots` открывает инструкцию по слотам без подключения к Paradev. [Руководство по CLI](docs/cli.md) · [Справочник команд](docs/commands.md) · [Конфигурация проекта](docs/cli.md#agent-clijson)

Управление Pen подключается отдельно. [pen-cli](https://github.com/burningyouth/pen-cli)

## Разработка

Для разработки выполните `npm test`. `npm run build:mcp` собирает общий архив для macOS и Linux. [Сборка и форматы поставки](docs/multi-agent-mcp.md#сборка-и-источники-форматов)

Для выпуска запустите **Run workflow** для ветки `main`. GitHub Actions проверит сборку, создаст релиз из версии в `mcp/plugin.json` и обновит пакеты Codex и OpenCode 2. [Build Paradev Agent Tools](https://github.com/burningyouth/paradev-agent-tools/actions/workflows/build.yml)
