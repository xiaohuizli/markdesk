import AppKit
import WebKit
import UniformTypeIdentifiers
import Darwin

let documentExtensions = ["md", "markdown", "mdx", "mdown", "mkd", "txt", "text", "rmd", "qmd"]

final class DocumentWebView: WKWebView {
    var openDocument: ((URL) -> Void)?
    func droppedFile(_ sender: NSDraggingInfo) -> URL? {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        return urls?.first(where: { documentExtensions.contains($0.pathExtension.lowercased()) })
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { droppedFile(sender) == nil ? [] : .copy }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggingEntered(sender) }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { droppedFile(sender) != nil }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let url = droppedFile(sender) else { return false }; openDocument?(url); return true
    }
}

final class PaperApplication: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var backend: Process?
    var origin: URL?
    var outputBuffer = Data()
    var errorText = ""
    var stopping = false
    var terminationReplied = false
    var scopedFolders: [URL] = []
    var launchTimer: Timer?
    var rendererIsReady = false
    var pendingFile: URL?
    var logURL: URL? { ProcessInfo.processInfo.environment["PAPER_DESKTOP_LOG"].map { URL(fileURLWithPath: $0) } }

    func log(_ event: String, _ fields: [String: Any] = [:]) {
        guard let url = logURL else { return }
        var record = fields
        record["event"] = event; record["at"] = ISO8601DateFormatter().string(from: Date()); record["appPid"] = ProcessInfo.processInfo.processIdentifier
        guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        data.append(0x0a)
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: url) { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "paperNative")
        controller.addUserScript(WKUserScript(source: """
        (() => {
          const callbacks = new Map(); let counter = 0;
          window.__paperNativeReply = (id, value, error) => {
            const item = callbacks.get(id); if (!item) return;
            callbacks.delete(id); clearTimeout(item.timer);
            error ? item.reject(new Error(error)) : item.resolve(value);
          };
          window.paperDesktop = Object.freeze({ request(method, data = {}) {
            return new Promise((resolve, reject) => {
              const id = 'native-' + (++counter);
              const timer = setTimeout(() => { callbacks.delete(id); reject(new Error('操作超时，请重试')); }, 300000);
              callbacks.set(id, { resolve, reject, timer });
              window.webkit.messageHandlers.paperNative.postMessage({ id, method, data });
            });
          }});
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller
        let documentView = DocumentWebView(frame: .zero, configuration: config)
        documentView.registerForDraggedTypes([.fileURL])
        documentView.openDocument = { [weak self] url in _ = self?.acceptFile(url, source: "drop") }
        webView = documentView
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "未命名"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 700, height: 450)
        window.contentView = webView
        window.setFrameAutosaveName("PaperSearchMainWindow")
        window.center(); window.makeKeyAndOrderFront(nil)
        buildMenus(); NSApp.activate(ignoringOtherApps: true)
        log("app.launch", ["bundle": Bundle.main.bundlePath])
        startBackend()
    }

    func startBackend() {
        guard let resources = Bundle.main.resourceURL else { return showError("无法找到应用资源") }
        let app = resources.appendingPathComponent("app", isDirectory: true)
        let node = resources.appendingPathComponent("runtime/node")
        let child = Process(), stdout = Pipe(), stderr = Pipe()
        child.executableURL = node
        child.arguments = [app.appendingPathComponent("src/server.js").path]
        child.currentDirectoryURL = app
        var env = ProcessInfo.processInfo.environment
        for key in ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"] { env.removeValue(forKey: key) }
        env["PORT"] = "0"; env["PAPER_DESKTOP"] = "1"; env["PAPER_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // A saved path alone does not restore a macOS file-access grant.
        // Only reuse a bookmark whose scope was successfully reacquired.
        env["PAPER_WORKSPACE"] = env["PAPER_WORKSPACE"] ?? app.appendingPathComponent("demo").path
        if ProcessInfo.processInfo.environment["PAPER_WORKSPACE"] == nil,
           let data = UserDefaults.standard.data(forKey: "workspaceBookmark") {
            var stale = false
            if let folder = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale), !stale,
               folder.startAccessingSecurityScopedResource() {
                scopedFolders.append(folder); env["PAPER_WORKSPACE"] = folder.path
            } else { log("workspace.restore-fallback", ["reason": "bookmark unavailable or stale"]) }
        }
        child.environment = env; child.standardOutput = stdout; child.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { if let self { self.errorText = String((self.errorText + String(decoding: data, as: UTF8.self)).suffix(4000)) } }
        }
        child.terminationHandler = { [weak self] process in DispatchQueue.main.async {
            guard let self else { return }
            self.log("backend.exit", ["pid": process.processIdentifier, "status": process.terminationStatus])
            if self.stopping { self.replyTermination() }
            else { self.showError("搜索服务已退出。\n" + self.errorText) }
        } }
        backend = child
        do {
            try child.run()
            log("backend.spawn", ["pid": child.processIdentifier, "executable": node.path, "workspace": env["PAPER_WORKSPACE"] ?? ""])
            launchTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in if self?.origin == nil { self?.showError("搜索服务启动超时。\n" + (self?.errorText ?? "")) } }
        } catch { showError("无法启动搜索服务：\(error.localizedDescription)") }
    }

    func consume(_ data: Data) {
        outputBuffer.append(data)
        while let range = outputBuffer.firstRange(of: Data([0x0a])) {
            let line = Data(outputBuffer[..<range.lowerBound]); outputBuffer.removeSubrange(..<range.upperBound)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], object["event"] as? String == "ready", let value = object["url"] as? String, let url = URL(string: value), url.host == "127.0.0.1", url.scheme == "http" else { continue }
            origin = url; launchTimer?.invalidate(); log("backend.ready", ["url": value]); webView.load(URLRequest(url: url))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { log("ui.ready", ["url": webView.url?.absoluteString ?? ""]) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || (url.scheme == origin?.scheme && url.host == origin?.host && url.port == origin?.port) { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let origin,
              message.frameInfo.securityOrigin.host == origin.host,
              message.frameInfo.securityOrigin.port == origin.port,
              let body = message.body as? [String: Any], let id = body["id"] as? String, let method = body["method"] as? String else { return }
        let data = body["data"] as? [String: Any] ?? [:]
        log("bridge.request", ["method": method, "id": id])
        switch method {
        case "rendererReady":
            rendererIsReady = true
            let path = pendingFile?.path; pendingFile = nil
            reply(id, ["path": path.map { $0 as Any } ?? NSNull()])
        case "chooseFile":
            chooseFile { url in self.reply(id, ["path": url.map { $0.path as Any } ?? NSNull()]) }
        case "chooseFolder":
            chooseFolder(current: data["currentPath"] as? String) { url in self.reply(id, ["path": url.map { $0.path as Any } ?? NSNull()]) }
        case "workspaceDidChange":
            if let folder = data["path"] as? String {
                UserDefaults.standard.set(folder, forKey: "workspace")
                if window.title == "未命名" { window.title = "未命名 — " + ((data["name"] as? String) ?? URL(fileURLWithPath: folder).lastPathComponent) }
                log("workspace.changed", ["path": folder]); reply(id, ["ok": true])
            } else { reply(id, [:], error: "文件夹路径无效") }
        case "documentDidChange":
            if let name = data["name"] as? String { window.title = name; log("document.changed", ["name": name]); reply(id, ["ok": true]) }
            else { reply(id, [:], error: "文档名称无效") }
        case "saveTrace": saveTrace(id, data["data"])
        default: reply(id, [:], error: "不支持的操作")
        }
    }

    func reply(_ id: String, _ value: [String: Any], error: String? = nil) {
        webView.callAsyncJavaScript("window.__paperNativeReply(id, value, error)", arguments: ["id": id, "value": value, "error": error.map { $0 as Any } ?? NSNull()], in: nil, in: .page) { _ in }
    }
    func chooseFolder(current: String?, completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel(); panel.title = "打开文档文件夹"; panel.message = "选择要搜索的 Markdown 或文本文件夹。"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false; panel.prompt = "打开"
        if let current { panel.directoryURL = URL(fileURLWithPath: current) }
        panel.beginSheetModal(for: window) { response in
            self.log("folder.panel", ["selected": response == .OK])
            if response == .OK, let folder = panel.url {
                if folder.startAccessingSecurityScopedResource() { self.scopedFolders.append(folder) }
                if let bookmark = try? folder.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil) { UserDefaults.standard.set(bookmark, forKey: "workspaceBookmark") }
                completion(folder)
            } else { completion(nil) }
        }
    }
    func retainAccess(_ url: URL) {
        if url.startAccessingSecurityScopedResource() { scopedFolders.append(url) }
    }
    func chooseFile(completion: @escaping (URL?) -> Void) {
        let panel = NSOpenPanel(); panel.title = "打开 Markdown 或文本文件"; panel.prompt = "打开"
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = documentExtensions.compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return completion(nil) }
            self.retainAccess(url); self.log("file.panel", ["path": url.path]); completion(url)
        }
    }
    @discardableResult func acceptFile(_ url: URL, source: String) -> Bool {
        guard url.isFileURL, documentExtensions.contains(url.pathExtension.lowercased()) else { return false }
        retainAccess(url); log("file.open", ["path": url.path, "source": source, "rendererReady": rendererIsReady])
        if rendererIsReady {
            webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('paper-open-file', {detail:{path}}))", arguments: ["path": url.path], in: nil, in: .page) { _ in }
            window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        } else { pendingFile = url }
        return true
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        // One document window: the last supported file becomes the active document.
        let accepted = filenames.compactMap { name -> URL? in
            let url = URL(fileURLWithPath: name)
            return documentExtensions.contains(url.pathExtension.lowercased()) ? url : nil
        }
        if let url = accepted.last { acceptFile(url, source: "finder") }
        sender.reply(toOpenOrPrint: accepted.isEmpty ? .failure : .success)
    }
    @objc func openFile() { chooseFile { url in if let url { self.acceptFile(url, source: "menu") } } }
    func saveTrace(_ id: String, _ value: Any?) {
        guard let value, let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else { return reply(id, [:], error: "记录格式无效") }
        let panel = NSSavePanel(); panel.title = "导出搜索记录"; panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "Paper Search 记录.json"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return self.reply(id, ["saved": false]) }
            do { try data.write(to: url, options: .atomic); self.log("trace.saved", ["path": url.path]); self.reply(id, ["saved": true]) }
            catch { self.reply(id, [:], error: error.localizedDescription) }
        }
    }
    @objc func openFolder() { chooseFolder(current: UserDefaults.standard.string(forKey: "workspace")) { url in
        guard let url else { return }
        self.webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('paper-open-workspace', {detail:{path}}))", arguments: ["path": url.path], in: nil, in: .page) { _ in }
    } }
    @objc func focusSearch() { command("search") }
    @objc func focusDocumentFind() { command("find") }
    @objc func quickOpen() { command("quick") }
    func command(_ name: String) { webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('paper-command', {detail:name}))", arguments: ["name": name], in: nil, in: .page) { _ in } }
    @objc func sourceMode() { command("source") }
    @objc func toggleSidebar() { command("sidebar") }
    @objc func fileTree() { command("files") }
    @objc func outline() { command("outline") }
    @objc func exportTrace() { webView.evaluateJavaScript("document.querySelector('#export-trace').click()") }

    func buildMenus() {
        let bar = NSMenu()
        func menu(_ title: String) -> NSMenu { let item = NSMenuItem(); let menu = NSMenu(title: title); item.submenu = menu; bar.addItem(item); return menu }
        func item(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: key); entry.keyEquivalentModifierMask = modifiers; entry.target = target; menu.addItem(entry)
        }
        let app = menu("Paper Search")
        item(app, "关于 Paper Search", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp)
        app.addItem(.separator()); item(app, "隐藏 Paper Search", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        app.addItem(.separator()); item(app, "退出 Paper Search", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
        let file = menu("文件")
        item(file, "打开文件…", #selector(openFile), "o", target: self)
        item(file, "打开文件夹…", #selector(openFolder), "o", [.command, .option], target: self)
        item(file, "快速打开…", #selector(quickOpen), "o", [.command, .shift], target: self)
        item(file, "导出搜索记录…", #selector(exportTrace), "e", [.command, .shift], target: self)
        file.addItem(.separator()); item(file, "关闭窗口", #selector(NSWindow.performClose(_:)), "w", target: window)
        let edit = menu("编辑")
        item(edit, "撤销", Selector(("undo:")), "z"); item(edit, "重做", Selector(("redo:")), "z", [.command, .shift]); edit.addItem(.separator())
        item(edit, "剪切", #selector(NSText.cut(_:)), "x"); item(edit, "复制", #selector(NSText.copy(_:)), "c"); item(edit, "粘贴", #selector(NSText.paste(_:)), "v"); item(edit, "全选", #selector(NSText.selectAll(_:)), "a")
        let view = menu("显示")
        item(view, "文件", #selector(fileTree), target: self)
        item(view, "大纲", #selector(outline), target: self)
        item(view, "显示/隐藏侧边栏", #selector(toggleSidebar), "l", [.command, .shift], target: self)
        item(view, "源代码模式", #selector(sourceMode), "/", target: self)
        let search = menu("搜索")
        item(search, "文件夹搜索", #selector(focusSearch), "f", [.command, .shift], target: self)
        item(search, "文内查找", #selector(focusDocumentFind), "f", target: self)
        item(search, "快速打开", #selector(quickOpen), "k", target: self)
        let windows = menu("窗口"); item(windows, "最小化", #selector(NSWindow.performMiniaturize(_:)), "m", target: window); NSApp.windowsMenu = windows
        NSApp.mainMenu = bar
    }

    func showError(_ message: String) {
        guard !stopping else { return }
        launchTimer?.invalidate(); log("app.error", ["message": message])
        let alert = NSAlert(); alert.messageText = "Paper Search 无法启动"; alert.informativeText = message; alert.addButton(withTitle: "退出")
        alert.beginSheetModal(for: window) { _ in NSApp.terminate(nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        stopping = true; launchTimer?.invalidate()
        guard let backend, backend.isRunning else { return .terminateNow }
        log("app.quit", ["backendPid": backend.processIdentifier]); backend.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if backend.isRunning { kill(backend.processIdentifier, SIGKILL) }
            self.replyTermination()
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) { for folder in scopedFolders { folder.stopAccessingSecurityScopedResource() } }
    func replyTermination() { if !terminationReplied { terminationReplied = true; NSApp.reply(toApplicationShouldTerminate: true) } }
}

let app = NSApplication.shared
let delegate = PaperApplication()
app.delegate = delegate
app.run()
