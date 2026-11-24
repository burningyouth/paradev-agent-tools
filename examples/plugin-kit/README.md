# Шаблон плагина для Codex и OpenCode 2

Плагин описывается в переносимом `plugin.json`. В ту же папку можно положить
`skills/<name>/SKILL.md`, ресурсы и `mcp.json`. Сборщик выпускает снимок
`distribution/` для Git-маркетплейса Codex и Git-плагина OpenCode 2, а также
`<name>-<version>.tar.gz` и его SHA-256. Скиллы и MCP-конфигурация общие для обоих
клиентов. Для хуков, интерфейсов и других расширений API используйте настройки
соответствующего клиента.

## Собрать примеры

Go 1.26 или новее нужен на машине сборки. Сборщик запускается без Node.js.
Команды выполняются из корня репозитория.

```sh
mkdir -p dist
cd examples/plugin-kit
go run ./cmd/pack -source plugins/example-skills -out ../../dist/example-skills
go run ./cmd/pack -source plugins/example-status -go-package ./cmd/status -out ../../dist/example-status
```

`-out` указывает на новый каталог. Для следующего релиза задайте новый выходной
каталог и увеличьте версию в `plugin.json`.

- **Скиллы.** Скопируйте `plugins/example-skills`. Для совместимости с адаптером
  OpenCode используйте однострочный `description` в YAML и одинаковое имя скилла
  в заголовке и имени папки.
- **Удалённый MCP.** Добавьте в payload переносимый `mcp.json` с сервером типа
  `streamable-http` и его `url`. Сборка идёт той же командой, что и для скиллов.
  Удалённое подключение и авторизацию выполняет клиент.
- **Локальный MCP или CLI.** Скопируйте `plugins/example-status`. В примере
  `mcp.json` запускает `./launch mcp`, а `./launch status` показывает каталог и
  платформу. `-go-package` собирает Go-бинарники для macOS Apple Silicon и Linux
  x64 с `CGO_ENABLED=0`. Для реализации на другом языке передайте
  `-bin-dir DIR` с готовыми исполняемыми файлами `darwin-arm64` и `linux-amd64`.
  Пакет должен содержать все файлы, нужные исполняемым файлам при запуске.

## Установить пакет

Для запуска готового пакета достаточно выбранного клиента. Локальный MCP
запускается на macOS Apple Silicon и Linux x64. Для установки из Git понадобится
доступ к репозиторию, а для удалённого MCP — доступ к серверу.

**Codex.** Распакуйте архив и укажите абсолютный путь к распакованной папке.
Локальный пример с MCP устанавливается так.

```sh
codex plugin marketplace add /path/to/example-status
codex plugin add example-status@example-status-marketplace
```

Для примера со скиллом замените `example-status` на `example-skills`.
При публикации содержимого `distribution/` в Git можно указать репозиторий в
`codex plugin marketplace add OWNER/REPO --ref distribution` и обновлять его
через `codex plugin marketplace upgrade example-status-marketplace`.

**OpenCode 2.** Укажите абсолютный путь к распакованной папке в `opencode.jsonc`.
Клиент загружает JS-адаптер через собственную среду исполнения.

```json
{"plugins":["/path/to/example-status"]}
```

После публикации снимка в Git используйте
`opencode plugin add 'git+https://github.com/OWNER/REPO.git#distribution'`.
В клиенте проверьте соединение командой `opencode mcp list`. Для отдельного
запуска из терминала выполните `/path/to/example-status/plugins/example-status/launch status`.

## Проверить без Node и Go

На macOS достаточно запустить распакованный архив с `PATH=/usr/bin:/bin`.
Workflow [Check plugin kit](../../.github/workflows/plugin-kit.yml) проверяет
распакованный архив на macOS, а на Linux запускает его в Ubuntu-контейнере без
сети. Проверка сначала убеждается, что `node`, `npm` и `go` отсутствуют в
`PATH`, затем выполняет CLI-команду и проверяет MCP-инициализацию, список
инструментов и вызов `status`. В контейнер передаются готовые пакеты и
скомпилированный тестовый клиент.
