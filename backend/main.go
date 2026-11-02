// DBX 电子书阅读器 —— 原生 Sidecar
//
// 作用：把书库真正落到用户磁盘上。
//
// 浏览器沙箱里（iframe + `allow-scripts`、无 allow-same-origin）拿不到
// IndexedDB，也调不动 File System Access API 的目录选择器，插件只能把数据
// 留在内存。DBX 提供的官方途径就是 Sidecar：它以当前用户权限运行，
// 可以直接做文件 IO，前端通过 `window.dbxPlugin.invoke()` 走 JSON-RPC 调用。
//
// 目录布局（root 下）：
//
//	library.json        书单 / 笔记 / 阅读设置的索引（由 UI 提交的原始 JSON）
//	books/<id>.<ext>    书籍原文
//
// root 默认是宿主给的 DBX_PLUGIN_DATA_DIR/library，用户可以在界面上改成
// 任意绝对路径（例如 D:\Books\DBX 书库），切换时可选把旧数据整体搬过去。
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	dbxpluginsdk "github.com/mjj3610/dbx-ebook/backend/internal/dbxpluginsdk"
)

const (
	pluginID      = "com.mjj3610.ebook"
	pluginVersion = "1.2.7"
	libraryFile   = "library.json"
	booksDirName  = "books"
	configFile    = "config.json"
	// 单块数据上限，前端按 512KB 分块，这里留足余量
	maxChunkBytes = 4 * 1024 * 1024
)

// app 保存运行期状态；SDK 每个请求起一个协程，故统一加锁。
type app struct {
	mu      sync.Mutex
	dataDir string
	root    string
}

type config struct {
	Root      string `json:"root"`
	UpdatedAt int64  `json:"updatedAt"`
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("[dbx-ebook-backend] ")

	dataDir := os.Getenv("DBX_PLUGIN_DATA_DIR")
	if strings.TrimSpace(dataDir) == "" {
		// 本地调试（脱离宿主直接跑）时的兜底目录
		base, err := os.UserConfigDir()
		if err != nil {
			base = os.TempDir()
		}
		dataDir = filepath.Join(base, "dbx-ebook")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("创建数据目录失败：%v", err)
	}

	instance := &app{dataDir: dataDir}
	instance.root = instance.loadRoot()

	server := dbxpluginsdk.NewServer(
		dbxpluginsdk.Metadata{
			ID:           pluginID,
			Version:      pluginVersion,
			Capabilities: []string{},
		},
		instance,
	)
	if err := server.Serve(); err != nil {
		log.Fatalf("sidecar 退出：%v", err)
	}
}

/* ---------------- 路径与配置 ---------------- */

// defaultRoot 默认书库位置：宿主分配的插件数据目录下的 library/
func (a *app) defaultRoot() string {
	return filepath.Join(a.dataDir, "library")
}

// loadRoot 读取 config.json 中的自定义根目录，没有就用默认值
func (a *app) loadRoot() string {
	fallback := a.defaultRoot()
	raw, err := os.ReadFile(filepath.Join(a.dataDir, configFile))
	if err != nil {
		return fallback
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil || strings.TrimSpace(cfg.Root) == "" {
		return fallback
	}
	return cfg.Root
}

func (a *app) saveRoot(root string) error {
	payload := config{Root: root, UpdatedAt: nowMillis()}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(a.dataDir, configFile), raw)
}

// isDefaultRoot 当前根目录是否仍是默认位置
func (a *app) isDefaultRoot() bool {
	return filepath.Clean(a.root) == filepath.Clean(a.defaultRoot())
}

// safeName 只允许纯文件名，杜绝 ../ 之类的越权写入
func safeName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", errors.New("文件名不能为空")
	}
	if strings.ContainsAny(trimmed, "/\\") || trimmed == "." || trimmed == ".." {
		return "", errors.New("文件名不能包含路径分隔符")
	}
	// Windows 保留字符
	if strings.ContainsAny(trimmed, ":*?\"<>|") {
		return "", errors.New("文件名包含非法字符")
	}
	if len(trimmed) > 200 {
		return "", errors.New("文件名过长")
	}
	return trimmed, nil
}

func (a *app) bookPath(name string) (string, error) {
	safe, err := safeName(name)
	if err != nil {
		return "", err
	}
	return filepath.Join(a.root, booksDirName, safe), nil
}

/* ---------------- 文件工具 ---------------- */

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// writeFileAtomic 先写临时文件再改名，避免中途崩溃留下半截 JSON
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

/* ---------------- Handler ---------------- */

// Handle 处理前端 invoke 过来的所有方法
func (a *app) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	_ *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	// 网络转发不参与全局锁：一次翻译可能耗时几十秒，占着锁会把阅读器
	// 所有的读写（book/read、library/write）全卡住。
	if method == "net/request" {
		return a.netRequest(params)
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	switch method {
	case "ping":
		return map[string]any{"ok": true, "version": pluginVersion, "platform": runtime.GOOS + "-" + runtime.GOARCH}, nil

	case "storage/describe":
		return a.describe()

	case "storage/setRoot":
		return a.setRoot(params)

	case "storage/resetRoot":
		return a.setRoot(json.RawMessage(`{}`))

	case "storage/listDirs":
		return a.listDirs(params)

	case "storage/reveal":
		return a.revealDir(params)

	case "storage/mkdir":
		return a.mkdir(params)

	case "library/read":
		return a.readLibrary()

	case "library/write":
		return a.writeLibrary(params)

	case "book/write":
		return a.writeBook(params)

	case "book/read":
		return a.readBook(params)

	case "book/stat":
		return a.statBook(params)

	case "book/delete":
		return a.deleteBook(params)

	case "book/list":
		return a.listBooks()
	}

	return nil, dbxpluginsdk.MethodNotFound(method)
}

func (a *app) describe() (any, *dbxpluginsdk.PluginError) {
	info := map[string]any{
		"dataDir":   a.dataDir,
		"root":      a.root,
		"isDefault": a.isDefaultRoot(),
		"platform":  runtime.GOOS,
		"exists":    dirExists(a.root),
		"writable":  isWritable(a.root),
	}
	if entries, err := os.ReadDir(filepath.Join(a.root, booksDirName)); err == nil {
		var total int64
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			if stat, err := entry.Info(); err == nil {
				total += stat.Size()
			}
		}
		info["bookCount"] = len(entries)
		info["booksBytes"] = total
	}
	if stat, err := os.Stat(filepath.Join(a.root, libraryFile)); err == nil {
		info["indexBytes"] = stat.Size()
	}
	return info, nil
}

func (a *app) setRoot(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Path string `json:"path"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
		}
	}

	target := a.defaultRoot()
	if strings.TrimSpace(request.Path) != "" {
		target = expandUser(strings.TrimSpace(request.Path))
		if !filepath.IsAbs(target) {
			return nil, dbxpluginsdk.NewError(-32602, "请填写绝对路径，例如 D:\\Books\\dbx-library")
		}
		target = filepath.Clean(target)
	}

	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "创建目录失败："+err.Error())
	}
	if !isWritable(target) {
		return nil, dbxpluginsdk.NewError(-32000, "目录不可写："+target)
	}

	previous := a.root
	if filepath.Clean(previous) != target {
		migrated, err := migrateLibrary(previous, target)
		if err != nil {
			log.Printf("迁移旧书库失败（继续使用新目录）：%v", err)
		}
		a.root = target
		if err := a.saveRoot(target); err != nil {
			log.Printf("保存书库位置失败：%v", err)
		}
		info, pluginErr := a.describe()
		if pluginErr != nil {
			return nil, pluginErr
		}
		if result, ok := info.(map[string]any); ok {
			result["migrated"] = migrated
		}
		return info, nil
	}

	info, pluginErr := a.describe()
	if pluginErr != nil {
		return nil, pluginErr
	}
	if result, ok := info.(map[string]any); ok {
		result["migrated"] = 0
	}
	return info, nil
}

// dirShortcuts 返回界面上的「快捷位置」，label 用 i18n key，由 UI 翻译
func (a *app) dirShortcuts() []map[string]any {
	shortcuts := make([]map[string]any, 0, 6)
	add := func(key, path string) {
		if dirExists(path) {
			shortcuts = append(shortcuts, map[string]any{"key": key, "path": path})
		}
	}
	add("library", a.root)
	add("data", a.dataDir)
	if home, err := os.UserHomeDir(); err == nil {
		add("home", home)
		add("documents", filepath.Join(home, "Documents"))
		add("desktop", filepath.Join(home, "Desktop"))
		add("downloads", filepath.Join(home, "Downloads"))
	}
	return shortcuts
}

// roots 返回可浏览的起点：Windows 是各盘符，其他平台是 /
func roots() []map[string]any {
	out := make([]map[string]any, 0, 4)
	if runtime.GOOS == "windows" {
		for letter := 'A'; letter <= 'Z'; letter++ {
			drive := string(letter) + ":\\"
			if dirExists(drive) {
				out = append(out, map[string]any{"name": string(letter) + ":", "path": drive})
			}
		}
		return out
	}
	out = append(out, map[string]any{"name": "/", "path": "/"})
	return out
}

// parentOf 返回上级目录；已经是根（盘符根 / "/"）时返回空串，防止一路往上翻
func parentOf(path string) string {
	parent := filepath.Dir(path)
	if parent == path {
		return ""
	}
	if filepath.Clean(parent) == filepath.Clean(string(os.PathSeparator)) {
		return ""
	}
	// Windows 盘符根：filepath.Dir("D:\\Books") == "D:\\"，而 Dir("D:\\") == "D:\\"
	if runtime.GOOS == "windows" && len(parent) == 3 && parent[1] == ':' {
		return ""
	}
	return parent
}

// skipDir 过滤掉不该出现在选择器里的系统目录
func skipDir(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") {
		return true
	}
	switch name {
	case "$RECYCLE.BIN", "System Volume Information", "Config.Msi", "Recovery",
		"node_modules", "__pycache__", "Windows", "Program Files", "Program Files (x86)",
		"ProgramData", "AppData":
		return true
	}
	return false
}

// listDirs 列出某个目录下的子目录，供 UI 的「选择文件夹」使用
// 不传 path 时返回盘符 / 快捷位置，让用户从起点开始浏览
func (a *app) listDirs(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Path string `json:"path"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
		}
	}

	raw := strings.TrimSpace(request.Path)
	if raw == "" {
		return map[string]any{
			"path":      "",
			"parent":    "",
			"roots":     roots(),
			"shortcuts": a.dirShortcuts(),
			"entries":   []map[string]any{},
		}, nil
	}

	target := expandUser(raw)
	if !filepath.IsAbs(target) {
		return nil, dbxpluginsdk.NewError(-32602, "请填写绝对路径，例如 D:\\Books")
	}
	target = filepath.Clean(target)
	if !dirExists(target) {
		return nil, dbxpluginsdk.NewError(-32000, "目录不存在："+target)
	}

	children, err := os.ReadDir(target)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "无法读取目录："+err.Error())
	}

	entries := make([]map[string]any, 0, len(children))
	for _, child := range children {
		if !child.IsDir() || skipDir(child.Name()) {
			continue
		}
		entries = append(entries, map[string]any{
			"name": child.Name(),
			"path": filepath.Join(target, child.Name()),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToLower(entries[i]["name"].(string)) < strings.ToLower(entries[j]["name"].(string))
	})

	return map[string]any{
		"path":      target,
		"parent":    parentOf(target),
		"entries":   entries,
		"roots":     roots(),
		"shortcuts": a.dirShortcuts(),
		"writable":  isWritable(target),
	}, nil
}

// netRequest 由后端代发 HTTP 请求
//
// 宿主给插件页面加的 CSP 是 connect-src 'none'（见 dev-runtime 的沙箱头），
// 页面里 fetch 任何外部地址都会直接抛 "Failed to fetch"。翻译与 WebDAV 备份
// 因此在真实宿主里必然失败，只能绕到后端：它以用户身份直接联网，不受 iframe
// 的 CSP 限制，也就能支持用户自填的任意 OpenAI 兼容接口 / 自建 WebDAV。
//
// 只放行 http/https（挡掉 file: 之类的本地读取），响应体上限 16MB。
const maxNetResponseBytes = 16 << 20

func (a *app) netRequest(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		URL       string            `json:"url"`
		Method    string            `json:"method"`
		Headers   map[string]string `json:"headers"`
		Body      string            `json:"body"` // base64
		TimeoutMs int               `json:"timeoutMs"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
	}

	parsed, err := url.Parse(strings.TrimSpace(request.URL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, dbxpluginsdk.NewError(-32602, "只支持 http/https 地址")
	}

	method := strings.ToUpper(strings.TrimSpace(request.Method))
	if method == "" {
		method = http.MethodGet
	}

	var body io.Reader
	if request.Body != "" {
		raw, decodeErr := base64.StdEncoding.DecodeString(request.Body)
		if decodeErr != nil {
			return nil, dbxpluginsdk.NewError(-32602, "请求体不是合法的 base64")
		}
		body = bytes.NewReader(raw)
	}

	timeout := time.Duration(request.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	req, err := http.NewRequest(method, parsed.String(), body)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "无法构造请求："+err.Error())
	}
	for key, value := range request.Headers {
		req.Header.Set(key, value)
	}

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "网络请求失败："+err.Error())
	}
	defer func() { _ = resp.Body.Close() }()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxNetResponseBytes))
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "读取响应失败："+err.Error())
	}

	headers := make(map[string]string, len(resp.Header))
	for key := range resp.Header {
		headers[key] = resp.Header.Get(key)
	}

	return map[string]any{
		"status":  resp.StatusCode,
		"headers": headers,
		"body":    base64.StdEncoding.EncodeToString(data),
		"url":     resp.Request.URL.String(),
	}, nil
}

// revealDir 用系统资源管理器打开目录
// 宿主沙箱（sandbox="allow-scripts"，origin 为 null）里 Chrome 会直接拒绝
// showDirectoryPicker，插件拿不到系统自带的目录选择框。所以给用户留一条
// 真正的「资源管理器」通路：在这里浏览、复制地址栏里的路径，再粘到插件的
// 地址栏里确认 —— 比自己画一棵目录树更接近用户熟悉的操作。
func (a *app) revealDir(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Path string `json:"path"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
		}
	}
	target := strings.TrimSpace(request.Path)
	if target == "" {
		target = a.root
	}
	target = filepath.Clean(expandUser(target))
	if !dirExists(target) {
		return nil, dbxpluginsdk.NewError(-32000, "目录不存在："+target)
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// explorer 对已存在的目录会直接打开；它的返回码不可靠，所以不检查退出码
		cmd = exec.Command("explorer", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if err := cmd.Start(); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "无法打开文件管理器："+err.Error())
	}
	// 不等待：资源管理器会一直开着，等它退出会把 RPC 卡死
	go func() { _ = cmd.Wait() }()
	return map[string]any{"ok": true, "path": target}, nil
}

// mkdir 在指定父目录下新建文件夹，返回新目录的绝对路径
func (a *app) mkdir(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
		}
	}
	parent := expandUser(strings.TrimSpace(request.Parent))
	name := strings.TrimSpace(request.Name)
	if name == "" {
		return nil, dbxpluginsdk.NewError(-32602, "请填写文件夹名称")
	}
	if !filepath.IsAbs(parent) {
		return nil, dbxpluginsdk.NewError(-32602, "请填写绝对路径")
	}
	// 文件夹名不允许带路径分隔符，避免越权建到别处
	if strings.ContainsAny(name, `/\:*?"<>|`) || name == "." || name == ".." {
		return nil, dbxpluginsdk.NewError(-32602, "文件夹名称包含非法字符")
	}
	target := filepath.Join(filepath.Clean(parent), name)
	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "创建文件夹失败："+err.Error())
	}
	return map[string]any{"path": target}, nil
}

// migrateLibrary 把旧根目录的 library.json 与 books/ 复制到新根目录
// 返回复制的文件数量；新目录已有 library.json 时不做任何事，避免覆盖用户数据。
func migrateLibrary(from, to string) (int, error) {
	if from == "" || filepath.Clean(from) == filepath.Clean(to) || !dirExists(from) {
		return 0, nil
	}
	if fileExists(filepath.Join(to, libraryFile)) {
		return 0, nil
	}
	copied := 0
	if err := copyFile(filepath.Join(from, libraryFile), filepath.Join(to, libraryFile)); err == nil {
		copied++
	}
	sourceDir := filepath.Join(from, booksDirName)
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		return copied, nil
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if err := copyFile(filepath.Join(sourceDir, entry.Name()), filepath.Join(to, booksDirName, entry.Name())); err != nil {
			return copied, err
		}
		copied++
	}
	return copied, nil
}

func (a *app) readLibrary() (any, *dbxpluginsdk.PluginError) {
	path := filepath.Join(a.root, libraryFile)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{"exists": false, "json": "", "size": 0}, nil
	}
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "读取书库索引失败："+err.Error())
	}
	return map[string]any{"exists": true, "json": string(raw), "size": len(raw)}, nil
}

func (a *app) writeLibrary(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		JSON string `json:"json"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
	}
	if len(request.JSON) > 64*1024*1024 {
		return nil, dbxpluginsdk.NewError(-32602, "书库索引过大")
	}
	path := filepath.Join(a.root, libraryFile)
	if err := writeFileAtomic(path, []byte(request.JSON)); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "写入书库索引失败："+err.Error())
	}
	return map[string]any{"size": len(request.JSON), "path": path}, nil
}

// writeBook 分块写入书籍原文
//
// params: { name, offset, dataBase64, truncate }
// offset 为 0 且 truncate 为真时先清空文件，便于重写同名书籍。
func (a *app) writeBook(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Name       string `json:"name"`
		Offset     int64  `json:"offset"`
		DataBase64 string `json:"dataBase64"`
		Truncate   bool   `json:"truncate"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
	}
	path, err := a.bookPath(request.Name)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, err.Error())
	}
	data, err := base64.StdEncoding.DecodeString(request.DataBase64)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "数据不是合法的 base64")
	}
	if len(data) > maxChunkBytes {
		return nil, dbxpluginsdk.NewError(-32602, "单块数据过大")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "创建 books 目录失败："+err.Error())
	}

	flags := os.O_WRONLY | os.O_CREATE
	if request.Truncate && request.Offset == 0 {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(path, flags, 0o644)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "打开书籍文件失败："+err.Error())
	}
	defer file.Close()

	if _, err := file.Seek(request.Offset, io.SeekStart); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "定位写入位置失败："+err.Error())
	}
	written, err := file.Write(data)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "写入书籍失败："+err.Error())
	}
	stat, err := file.Stat()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "读取文件状态失败："+err.Error())
	}
	return map[string]any{"written": written, "size": stat.Size(), "path": path}, nil
}

func (a *app) readBook(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Name   string `json:"name"`
		Offset int64  `json:"offset"`
		Length int    `json:"length"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
	}
	path, err := a.bookPath(request.Name)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, err.Error())
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{"exists": false, "dataBase64": "", "size": 0, "eof": true}, nil
	}
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "打开书籍失败："+err.Error())
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "读取文件状态失败："+err.Error())
	}
	length := request.Length
	if length <= 0 || length > maxChunkBytes {
		length = 512 * 1024
	}
	buffer := make([]byte, length)
	if _, err := file.Seek(request.Offset, io.SeekStart); err != nil {
		return nil, dbxpluginsdk.NewError(-32000, "定位读取位置失败："+err.Error())
	}
	read, err := io.ReadFull(file, buffer)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, dbxpluginsdk.NewError(-32000, "读取书籍失败："+err.Error())
	}
	buffer = buffer[:read]
	next := request.Offset + int64(read)
	return map[string]any{
		"exists":     true,
		"dataBase64": base64.StdEncoding.EncodeToString(buffer),
		"size":       stat.Size(),
		"nextOffset": next,
		"eof":        next >= stat.Size(),
	}, nil
}

func (a *app) statBook(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
	}
	path, err := a.bookPath(request.Name)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, err.Error())
	}
	stat, err := os.Stat(path)
	if err != nil {
		return map[string]any{"exists": false, "size": 0, "path": path}, nil
	}
	return map[string]any{"exists": true, "size": stat.Size(), "path": path}, nil
}

func (a *app) deleteBook(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var request struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, dbxpluginsdk.NewError(-32602, "参数格式错误")
	}
	path, err := a.bookPath(request.Name)
	if err != nil {
		return nil, dbxpluginsdk.NewError(-32602, err.Error())
	}
	err = os.Remove(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, dbxpluginsdk.NewError(-32000, "删除书籍失败："+err.Error())
	}
	return map[string]any{"deleted": err == nil, "path": path}, nil
}

func (a *app) listBooks() (any, *dbxpluginsdk.PluginError) {
	entries, err := os.ReadDir(filepath.Join(a.root, booksDirName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{"books": []any{}}, nil
		}
		return nil, dbxpluginsdk.NewError(-32000, "读取 books 目录失败："+err.Error())
	}
	books := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		size := int64(0)
		if stat, err := entry.Info(); err == nil {
			size = stat.Size()
		}
		books = append(books, map[string]any{"name": entry.Name(), "size": size})
	}
	sort.Slice(books, func(i, j int) bool { return books[i]["name"].(string) < books[j]["name"].(string) })
	return map[string]any{"books": books, "root": a.root}, nil
}
