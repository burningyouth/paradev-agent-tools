import AppKit

private enum SetupError: LocalizedError {
    case missingLauncher
    var errorDescription: String? { "В приложении отсутствует установщик. Распакуйте архив заново." }
}

private struct SetupReply: Decodable {
    let message: String?
    let versionChoice: Bool?
}

private struct DiagnosticReport: Decodable {
    struct Check: Decodable {
        let name: String
        let status: String
        let detail: String
    }
    struct Host: Decodable {
        let status: String
        let hint: String?
    }
    let ok: Bool
    let checks: [Check]
    let host: Host

    var summary: String {
        if ok { return "Paradev отвечает. Git и остальные обязательные зависимости доступны." }
        var problems = checks.filter { $0.status == "missing" }.map { "\($0.name) — \($0.detail)" }
        if let hint = host.hint { problems.append(hint) }
        return problems.isEmpty ? "Диагностика завершилась с ошибкой." : problems.joined(separator: "\n")
    }
}

private func runLauncher(_ arguments: [String]) throws -> Data {
    guard let launcher = Bundle.main.resourceURL?.appendingPathComponent("multi-agent-mcp/launch"),
          FileManager.default.isExecutableFile(atPath: launcher.path) else { throw SetupError.missingLauncher }
    let process = Process()
    let pipe = Pipe()
    process.executableURL = launcher
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return output
}

final class SetupWindow: NSObject, NSApplicationDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 472, height: 292),
        styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false
    )
    private let status = NSTextField(wrappingLabelWithString: "")
    private var controls: [NSButton] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Paradev Agent Tools"
        window.center()

        let title = NSTextField(labelWithString: "Подключите клиент")
        title.font = .systemFont(ofSize: 23, weight: .semibold)
        let introduction = NSTextField(wrappingLabelWithString: "Выберите, из какого чата будете управлять сессиями и слотами Paradev.")
        introduction.textColor = .secondaryLabelColor

        let codex = NSButton(title: "Подключить Codex", target: self, action: #selector(connectCodex))
        let openCode = NSButton(title: "Подключить OpenCode", target: self, action: #selector(connectOpenCode))
        let diagnostics = NSButton(title: "Проверить Paradev", target: self, action: #selector(diagnose))
        controls = [codex, openCode, diagnostics]
        for control in controls { control.bezelStyle = .rounded }

        let clients = NSStackView(views: [codex, openCode])
        clients.spacing = 12
        let divider = NSBox()
        divider.boxType = .separator
        let content = NSStackView(views: [title, introduction, clients, divider, diagnostics, status])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.setCustomSpacing(18, after: clients)
        content.setCustomSpacing(14, after: divider)
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(content)
        if let view = window.contentView {
            NSLayoutConstraint.activate([
                content.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
                content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 26),
                content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -26),
                content.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -24),
                divider.widthAnchor.constraint(equalTo: content.widthAnchor),
                introduction.widthAnchor.constraint(equalTo: content.widthAnchor),
                status.widthAnchor.constraint(equalTo: content.widthAnchor),
            ])
        }
        status.isSelectable = true
        status.textColor = .secondaryLabelColor
        status.maximumNumberOfLines = 0
        let menu = NSMenu()
        let mainItem = NSMenuItem()
        menu.addItem(mainItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Закрыть Paradev Agent Tools", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        mainItem.submenu = appMenu
        NSApp.mainMenu = menu
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @objc private func connectCodex() { install("codex") }
    @objc private func connectOpenCode() { install("opencode-auto") }

    private func install(_ client: String) {
        perform(["--install", client, "--json"], pending: "Подключаем клиент…") { data in
            if let reply = try? JSONDecoder().decode(SetupReply.self, from: data) {
                if reply.versionChoice == true { self.selectOpenCodeVersion() }
                else { self.show(reply.message ?? "Клиент подключён.") }
            } else { self.showOutput(data) }
        }
    }

    private func selectOpenCodeVersion() {
        show("")
        let alert = NSAlert()
        alert.messageText = "Какой OpenCode установлен?"
        alert.informativeText = "Проверьте номер версии в меню OpenCode → About OpenCode."
        alert.addButton(withTitle: "OpenCode 2")
        alert.addButton(withTitle: "OpenCode 1")
        alert.addButton(withTitle: "Отмена")
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { self.install("opencode") }
            if response == .alertSecondButtonReturn { self.install("opencode-v1") }
        }
    }

    @objc private func diagnose() {
        perform(["--diagnose"], pending: "Проверяем доступ к Paradev…") { data in
            if let report = try? JSONDecoder().decode(DiagnosticReport.self, from: data) {
                self.show(report.summary)
            } else { self.showOutput(data) }
        }
    }

    private func perform(_ arguments: [String], pending: String, finish: @escaping (Data) -> Void) {
        show(pending)
        controls.forEach { $0.isEnabled = false }
        DispatchQueue.global(qos: .userInitiated).async {
            let data: Data
            do { data = try runLauncher(arguments) }
            catch { data = Data(error.localizedDescription.utf8) }
            DispatchQueue.main.async {
                self.controls.forEach { $0.isEnabled = true }
                finish(data)
            }
        }
    }

    private func showOutput(_ data: Data) {
        let message = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        show(message.isEmpty ? "Установщик завершился без ответа." : message)
    }

    private func show(_ message: String) {
        status.stringValue = message
        let nextHeight = max(292, 238 + status.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: 420, height: 1000)).height)
        let newSize = NSSize(width: 472, height: nextHeight)
        if window.contentView?.bounds.size != newSize { window.setContentSize(newSize) }
    }
}

let app = NSApplication.shared
let delegate = SetupWindow()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
