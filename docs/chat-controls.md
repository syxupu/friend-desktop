# 聊天操作（0.1.4 起）

聊天小窗标题栏的图钉切换原生 Windows 窗口置顶，按下时高亮，状态以 `chatAlwaysOnTop` 保存在设置中。置顶不会重配酒馆或打断正在生成的回复。设置写入成功后更新窗口；写入失败保留原有状态。退出等待在途置顶设置提交。

双方已保存的消息下方提供编辑和删除；编辑窗口保留输入草稿，保存失败时在窗口内提示，可重试或取消。删除有确认提示，只移除选中的一条，不截断后续消息。消息使用持久化的 UUID 标识，并校验打开编辑窗口时的原文，避免删除后数组下标变化、过时编辑或其他酒馆操作覆盖错误消息。

修改采用“构建副本、酒馆 API 确认保存、更新内存及两端界面”的顺序。保留聊天头和完整性标识，不绕过酒馆的完整性保护。编辑同步当前 swipe 文本；本次原型未提供切换 swipe 的小窗入口。生成、设置、记录修改和服务重启互斥；学习开始、暂停等控制仍可执行。修改记录时停止旧语音，防止已删除或已修改的文本继续播报。

最新一条消息是角色回复时，可点击重新生成。使用酒馆原生 `regenerate`，沿用当前上下文和流式展示、台词提取及 TTS 流程。成功后替换原回复，不添加用户消息，也不增加学习聊天轮数。取消和失败恢复原回复；发起请求前把原会话快照存入该聊天的恢复元数据，避免酒馆原生重新生成删除旧回复后，进程异常导致原文丢失。正常完成或回滚后移除快照；再次配置会话时先恢复未完成的快照。

Windows 10 本机实测中，Electron 的 `floating` 层级在取消后再次开启时可能未保持原生置顶标志。本实现使用 `pop-up-menu`，并在窗口首次加载完成后恢复选择；集成检查断言实际 `isAlwaysOnTop()`，包含反复开关和应用重启。层级语义参考 [Electron BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativelevel)。

对应代码：`src/main.ts` 负责操作准入、置顶与状态同步，`src/tavern-bridge.js` 负责稳定消息标识、保存和重新生成恢复，`src/renderer.ts` 负责入口及编辑、删除窗口。

验证：

- `npm test`：37 项检查，包含历史修改互斥、过时记录拒绝、重新生成不重复计数及取消恢复、置顶保存失败和系统通知顺序。
- `node scripts/chat-controls-integration.mjs`：开发版真实 Electron + SillyTavern，测试本机模拟模型。
- `node scripts/chat-controls-integration.mjs --packaged`：对当前版本成品重复界面、通知顺序、保存失败、取消、服务中断恢复及重启测试。
- 结果位于 `docs/chat-controls-dev-validation.json`、`docs/chat-controls-packaged-validation.json`，截图位于 `docs/screenshots/chat-controls-*.png`。模拟回复仅用于验证交互和数据流，没有调用用户的真实模型或语音 API。

当前用户数据目录未用于功能测试。已有角色、人设、世界书和个人聊天均不重置；用户需退出旧版本后运行 0.1.5。系统通知排序修复见 [0.1.5 记录](notice-order-fix.md)。
