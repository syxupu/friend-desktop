// Runs in the genuine pinned SillyTavern frontend. No provider API keys enter this world.
(async () => {
  const script = await import('/script.js');
  const wi = await import('/scripts/world-info.js');
  const secrets = await import('/scripts/secrets.js');
  const regex = await import('/scripts/extensions/regex/engine.js');
  const context = () => window.SillyTavern.getContext();
  const report = data => window.friendTavern.report(data);
  await new Promise(resolve => script.eventSource.on(script.event_types.APP_READY, resolve));
  let requestId = null;
  let cancelled = false;
  let last = '';
  let changing = false;
  let configuredAvatar = '';
  context().eventSource.on(context().eventTypes.STREAM_TOKEN_RECEIVED, text => {
    if (requestId && !cancelled) report({ type: 'stream', id: requestId, text: String(text) });
  });
  context().eventSource.on(context().eventTypes.MESSAGE_RECEIVED, id => {
    const message = context().chat[id];
    if (requestId && message && !message.is_user && !message.is_system) last = message.mes;
  });
  function history() {
    const used = new Set();
    return context().chat.filter(m => !m.is_system).map(m => {
      m.extra ??= {};
      if (!m.extra.friend_message_id || used.has(m.extra.friend_message_id)) m.extra.friend_message_id = crypto.randomUUID();
      used.add(m.extra.friend_message_id);
      return { id: `st-${m.extra.friend_message_id}`, role: m.is_user ? 'user' : 'assistant', text: String(m.mes ?? '') };
    });
  }
  function identity() {
    const ctx = context(), character = ctx.characters[ctx.characterId];
    if (character?.avatar !== configuredAvatar || ctx.groupId) throw new Error('酒馆已切换会话，请先重启对话服务同步');
    return { avatar_url: character.avatar, file_name: character.chat, ch_name: character.name };
  }
  function assertIdentity(expected) {
    if (JSON.stringify(identity()) !== JSON.stringify(expected)) throw new Error('酒馆会话已变化，操作已停止');
  }
  async function chatRequest(endpoint, body) {
    const response = await fetch(`/api/chats/${endpoint}`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error('聊天记录保存失败，请检查本机酒馆服务后重试');
    return response.json();
  }
  // Tavern's saveChat catches persistence failures internally. These operations
  // must acknowledge a checked server write before reporting success to Friend.
  async function saveHistory(chat, expected, unchanged) {
    assertIdentity(expected);
    const disk = await chatRequest('get', expected);
    assertIdentity(expected);
    if (unchanged !== undefined && JSON.stringify(context().chat) !== unchanged) throw new Error('聊天记录已变化，请重新选择消息');
    const header = Array.isArray(disk) && disk[0]?.chat_metadata ? disk[0] : {
      user_name: context().name1, character_name: context().name2, create_date: new Date().toISOString(),
    };
    if (header.chat_metadata?.integrity && header.chat_metadata.integrity !== context().chatMetadata.integrity) throw new Error('聊天文件已变化，请重启对话服务同步');
    await chatRequest('save', { ...expected, chat: [{ ...header, chat_metadata: { ...context().chatMetadata } }, ...chat] });
    assertIdentity(expected);
  }
  // Tavern creates a card greeting whenever it opens an empty chat. Remove the
  // message on disk as well as in memory, before returning history or generating.
  // Existing generated replies must survive even when they match a greeting.
  async function removeCardGreeting(fresh = false) {
    const ctx = context(), first = ctx.chat[0], character = ctx.characters[ctx.characterId];
    if (!first || first.is_user || first.is_system || first.gen_started || first.gen_finished || first.extra?.api || first.extra?.model ||
        first.swipe_info?.some(info => info.gen_started || info.gen_finished || info.extra?.api || info.extra?.model)) return;
    const greetings = [character.first_mes, ...(Array.isArray(character.data?.alternate_greetings) ? character.data.alternate_greetings : [])]
      .filter(value => typeof value === 'string' && value.length)
      .map(value => regex.getRegexedString(value, regex.regex_placement.AI_OUTPUT));
    if (!fresh && !greetings.includes(first.mes)) return;
    const expected = identity(), unchanged = JSON.stringify(ctx.chat), next = ctx.chat.slice(1);
    const previousBackup = ctx.chatMetadata.friend_greeting_backup;
    ctx.chatMetadata.friend_greeting_backup ??= { message: structuredClone(first), removedAt: new Date().toISOString() };
    let saved = false;
    changing = true;
    try {
      await saveHistory(next, expected, unchanged);
      saved = true;
      ctx.chat.splice(0, ctx.chat.length, ...next);
      await script.printMessages();
    } catch (cause) {
      if (!saved) {
        if (previousBackup === undefined) delete ctx.chatMetadata.friend_greeting_backup;
        else ctx.chatMetadata.friend_greeting_backup = previousBackup;
      }
      throw cause;
    } finally { changing = false; }
  }
  function targetIndex(change) {
    const index = context().chat.findIndex(m => !m.is_system && `st-${m.extra?.friend_message_id}` === change.id);
    if (index < 0 || String(context().chat[index].mes ?? '') !== change.expectedText) throw new Error('聊天记录已变化，请重新选择消息');
    return index;
  }
  async function definition(avatar) {
    const response = await fetch('/api/characters/all', { method: 'POST', headers: context().getRequestHeaders(), body: '{}' });
    if (!response.ok) throw new Error('角色读取失败');
    const all = await response.json(), character = all.find(item => item.avatar === avatar);
    if (!character) throw new Error('角色已不存在，请刷新列表');
    return { avatar, data: structuredClone(character.data) };
  }
  async function worldDefinition(data) {
    const name = data.extensions?.world;
    if (!name || !wi.world_names.includes(name)) return null;
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ name }) });
    if (!response.ok) throw new Error('关联世界书读取失败');
    return { name, data: await response.json() };
  }
  window.friendBridge = {
    async getDefinition({ avatar }) { const result = await definition(avatar); return { ...result, world: await worldDefinition(result.data) }; },
    async deleteArchivedChat({ chat }) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先停止酒馆中的回复');
      const ctx = context(), selected = ctx.characters[ctx.characterId];
      if (!ctx.groupId && selected?.avatar === chat.avatar && selected.chat === chat.fileName) throw new Error('不能删除酒馆当前使用的聊天，请先切换会话');
      changing = true;
      try {
        const result = await chatRequest('delete', { avatar_url: chat.avatar, chatfile: `${chat.fileName}.jsonl` });
        if (!result.ok) throw new Error('酒馆未确认删除聊天');
        const remaining = await chatRequest('get', { avatar_url: chat.avatar, file_name: chat.fileName });
        if (!Array.isArray(remaining) || remaining.length) throw new Error('聊天删除结果未确认');
      } finally { changing = false; }
    },
    async editLore({ avatar, expectedData, expectedWorld, book, worldCopy, worldName }) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先停止酒馆中的回复');
      changing = true;
      try {
        const current = await definition(avatar), world = await worldDefinition(current.data);
        if (JSON.stringify(current.data) !== expectedData || JSON.stringify(world) !== JSON.stringify(expectedWorld)) throw new Error('角色书已在其他窗口变化，请重新读取后再删除');
        const patch = {};
        if (book) patch.character_book = structuredClone(book);
        if (worldCopy) {
          const saved = await fetch('/api/worldinfo/edit', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ name: worldName, data: worldCopy }) });
          if (!saved.ok || !(await saved.json()).ok) throw new Error('世界书副本保存失败，原条目保留');
          const checked = await fetch('/api/worldinfo/get', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ name: worldName }) });
          if (!checked.ok || JSON.stringify(await checked.json()) !== JSON.stringify(worldCopy)) throw new Error('世界书副本保存结果未确认');
          patch.extensions = { world: worldName };
          if (patch.character_book) patch.character_book.name = worldName;
        }
        // Recheck after creating a private world copy; never overwrite concurrent advanced edits.
        if (JSON.stringify((await definition(avatar)).data) !== expectedData) throw new Error('角色已变化，请重新读取');
        const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ avatar, data: patch }) });
        if (!response.ok) throw new Error('条目删除未完成，原卡备份已保留');
        await context().getCharacters();
        const saved = await definition(avatar);
        if ((patch.character_book && JSON.stringify(saved.data.character_book) !== JSON.stringify(patch.character_book)) || (worldCopy && saved.data.extensions?.world !== worldName)) throw new Error('角色书保存结果未确认，请重新读取检查');
        if (worldCopy) { wi.worldInfoCache.delete(worldName); await wi.updateWorldInfoList(); }
      } finally { changing = false; }
    },
    async editDefinition({ avatar, expectedData, fields }) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先停止酒馆中的回复');
      changing = true;
      try {
        const current = await definition(avatar);
        if (JSON.stringify(current.data) !== expectedData) throw new Error('角色卡已在其他窗口变化，请重新读取后再保存');
        const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ avatar, ...fields, data: fields }) });
        if (!response.ok) throw new Error('角色卡保存失败，原卡备份已保留');
        await context().getCharacters();
        const saved = await definition(avatar);
        if (Object.entries(fields).some(([key, value]) => saved.data[key] !== value)) throw new Error('角色保存结果未确认，请重新读取检查');
        return saved;
      } finally { changing = false; }
    },
    async duplicateDefinition({ avatar }) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先停止酒馆中的回复');
      const response = await fetch('/api/characters/duplicate', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
      const result = await response.json();
      if (!response.ok || !result.path) throw new Error('角色副本创建失败');
      await context().getCharacters(); return result.path;
    },
    async configure(config) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先停止酒馆中的回复，再同步角色');
      const ctx = context();
      ctx.powerUserSettings.world_import_dialog = false;
      script.setUserName(config.userName, { toastPersonaNameChange: false });
      script.changeMainAPI('openai');
      Object.assign(ctx.chatCompletionSettings, { chat_completion_source: 'custom', custom_url: config.url, custom_model: config.model,
        custom_prompt_post_processing: 'none', custom_include_headers: '', custom_include_body: '', custom_exclude_body: '',
        stream_openai: true, openai_max_context: 65536, openai_max_tokens: 1024, temperature: 0.8,
        reverse_proxy: '', proxy_password: '', show_thoughts: false, bypass_status_check: false,
      });
      // The pinned UI change handler updates dependent forms.
      window.$('#chat_completion_source').val('custom').trigger('change');
      ctx.chatCompletionSettings.custom_url = config.url;
      ctx.chatCompletionSettings.custom_model = config.model;
      await secrets.writeSecret(secrets.SECRET_KEYS.CUSTOM, config.token, 'Friend 本机临时转发令牌');
      script.setOnlineStatus('Friend 本机转发已就绪');
      let index = context().characters.findIndex(c => c.avatar === config.avatar);
      if (index < 0) { await ctx.getCharacters(); index = context().characters.findIndex(c => c.avatar === config.avatar); }
      if (index < 0) throw new Error('导入角色未找到');
      await context().selectCharacterById(index, { switchMenu: false });
      configuredAvatar = config.avatar;
      // A crash during native regeneration may leave a partial replacement on
      // disk. Restore the durable original before exposing history to Friend.
      const backup = context().chatMetadata.friend_regeneration_backup;
      if (backup) {
        const expected = identity();
        if (backup.avatar !== expected.avatar_url || backup.chatId !== expected.file_name || !Array.isArray(backup.chat)) throw new Error('重新生成备份不匹配，请检查酒馆会话');
        context().chat.splice(0, context().chat.length, ...backup.chat);
        delete context().chatMetadata.friend_regeneration_backup;
        try { await saveHistory(context().chat, expected); }
        catch (cause) { context().chatMetadata.friend_regeneration_backup = backup; throw cause; }
        await script.printMessages();
      }
      // Import only once. On later runs honor the user's edits in the advanced Tavern window.
      const character = context().characters[index];
      if (!character.data?.extensions?.world || !wi.world_names.includes(character.data.extensions.world)) {
        window.$('#import_character_info').data('chid', index);
        await wi.importEmbeddedWorldInfo(true);
        const importedName = character.data?.character_book?.name || `${character.name}'s Lorebook`;
        if (wi.world_names.includes(importedName)) {
          // The native selector saves its association asynchronously. Confirm it
          // on disk before exposing lore deletion or duplicating this character.
          const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ avatar: config.avatar, data: { extensions: { world: importedName } } }) });
          if (!response.ok || (await definition(config.avatar)).data.extensions?.world !== importedName) throw new Error('角色世界书关联保存未确认');
          await context().getCharacters();
        }
      }
      window.$('#world_info_budget').val(100).trigger('input');
      context().saveSettingsDebounced();
      await removeCardGreeting();
      const messages = history();
      await saveHistory(context().chat, identity());
      const ref = identity();
      return { character: character.name, entries: character.data?.character_book?.entries?.length ?? 0, messages, chat: { avatar: ref.avatar_url, fileName: ref.file_name } };
    },
    async getConversation() {
      if (requestId || changing || script.isGenerating()) throw new Error('请先等待当前回复结束');
      await removeCardGreeting();
      const ref = identity(), messages = history();
      await saveHistory(context().chat, ref);
      return { messages, chat: { avatar: ref.avatar_url, fileName: ref.file_name, characterName: ref.ch_name } };
    },
    async openConversation({ chat }) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先等待当前回复结束');
      const current = identity();
      if (chat.avatar !== current.avatar_url || typeof chat.fileName !== 'string' || /[\\/\x00]/.test(chat.fileName) || !chat.fileName || ['.', '..'].includes(chat.fileName)) throw new Error('聊天标识不正确');
      const target = { ...current, file_name: chat.fileName };
      const disk = await chatRequest('get', target);
      await context().openCharacterChat(chat.fileName);
      // All desktop chats start empty, including old allowGreeting references.
      await removeCardGreeting(!Array.isArray(disk) || disk.length < 2);
      const messages = history(); await saveHistory(context().chat, identity());
      await script.printMessages();
      return { messages, chat };
    },
    async changeMessage(change) {
      if (requestId || changing || script.isGenerating()) throw new Error('对话正在生成');
      const expected = identity(), ctx = context(), index = targetIndex(change);
      if (!['edit', 'delete'].includes(change.action)) throw new Error('未知聊天操作');
      if (change.action === 'edit' && (typeof change.text !== 'string' || !change.text.trim() || change.text.length > 20000)) throw new Error('消息应为 1–20000 个字符');
      const unchanged = JSON.stringify(ctx.chat), next = structuredClone(ctx.chat);
      if (change.action === 'delete') next.splice(index, 1);
      else {
        next[index].mes = change.text;
        if (Array.isArray(next[index].swipes)) next[index].swipes[next[index].swipe_id ?? 0] = change.text;
        if (next[index].extra) delete next[index].extra.display_text;
      }
      changing = true; ctx.deactivateSendButtons();
      try {
        await saveHistory(next, expected, unchanged);
        ctx.chat.splice(0, ctx.chat.length, ...next);
        await script.printMessages();
        await ctx.eventSource.emit(change.action === 'delete' ? ctx.eventTypes.MESSAGE_DELETED : ctx.eventTypes.MESSAGE_EDITED,
          change.action === 'delete' ? ctx.chat.length : index);
        return { messages: history() };
      } finally { changing = false; ctx.activateSendButtons(); }
    },
    async generate({ id, text, study, automatic = false, regeneration, companion }) {
      if (requestId || changing || script.isGenerating()) throw new Error('对话正在生成');
      const expected = identity();
      let original;
      requestId = id; last = ''; cancelled = false;
      const ctx = context();
      ctx.setExtensionPrompt('friend-companion', typeof companion === 'string' ? companion : '', script.extension_prompt_types.IN_CHAT, 0, false, 0);
      const prefix = '你正在桌宠中陪伴真实用户学习。角色卡的情节与用户设定属于虚构，不能作为真实学习进度。不要替用户执行软件操作。当前没有摄像头或桌面观察数据。自然回应用户；动作与旁白可保留，真正说出的台词请使用中文双引号“…”包围，方便语音播报。';
      ctx.setExtensionPrompt('friend-study', `${prefix}\n当前状态：${study.mode}；学习主题：${study.topic || '未设置'}；本段学习 ${Math.floor(study.elapsedMs / 60000)} 分钟。${automatic ? '\n此条为休息开场：用角色语气简短鼓励用户休息一次，不要替用户回答。' : ''}`, script.extension_prompt_types.IN_CHAT, 0, false, 0);
      try {
        await removeCardGreeting();
        if (cancelled) throw new Error('生成已取消');
        if (regeneration) {
          const index = targetIndex(regeneration), message = ctx.chat[index];
          if (index !== ctx.chat.length - 1 || message.is_user) throw new Error('只能重新生成最新一条角色回复');
          original = structuredClone(ctx.chat);
        }
        if (original) {
          ctx.chatMetadata.friend_regeneration_backup = { avatar: expected.avatar_url, chatId: expected.file_name, chat: original };
          await saveHistory(original, expected);
        }
        if (cancelled) throw new Error('生成已取消');
        if (!automatic && !regeneration) window.$('#send_textarea').val(text);
        else window.$('#send_textarea').val('');
        await ctx.generate(regeneration ? 'regenerate' : 'normal', { automatic_trigger: automatic });
        if (cancelled) throw new Error('生成已取消');
        if (!last) throw new Error('角色没有返回完整回复');
        const messages = history();
        if (original) delete ctx.chatMetadata.friend_regeneration_backup;
        await saveHistory(ctx.chat, expected);
        if (cancelled) throw new Error('生成已取消');
        return { text: last, messages };
      } catch (cause) {
        if (original) {
          assertIdentity(expected);
          ctx.chat.splice(0, ctx.chat.length, ...original);
          await script.printMessages();
          delete ctx.chatMetadata.friend_regeneration_backup;
          try { await saveHistory(original, expected); }
          catch { throw new Error('原回复恢复尚未保存，请重启对话服务重试'); }
        }
        throw cause;
      } finally { requestId = null; }
    },
    history,
    stop: () => { cancelled = true; return context().stopGeneration(); },
  };
  report({ type: 'ready' });
})().catch(() => window.friendTavern.report({ type: 'error', message: '酒馆桥接初始化失败' }));
