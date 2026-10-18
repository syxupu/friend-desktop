// Runs in the genuine pinned SillyTavern frontend. No provider API keys enter this world.
(async () => {
  const script = await import('/script.js');
  const wi = await import('/scripts/world-info.js');
  const secrets = await import('/scripts/secrets.js');
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
  function targetIndex(change) {
    const index = context().chat.findIndex(m => !m.is_system && `st-${m.extra?.friend_message_id}` === change.id);
    if (index < 0 || String(context().chat[index].mes ?? '') !== change.expectedText) throw new Error('聊天记录已变化，请重新选择消息');
    return index;
  }
  window.friendBridge = {
    async configure(config) {
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
      }
      window.$('#world_info_budget').val(100).trigger('input');
      context().saveSettingsDebounced();
      const messages = history();
      await saveHistory(context().chat, identity());
      const ref = identity();
      return { character: character.name, entries: character.data?.character_book?.entries?.length ?? 0, messages, chat: { avatar: ref.avatar_url, fileName: ref.file_name } };
    },
    async getConversation() {
      if (requestId || changing || script.isGenerating()) throw new Error('请先等待当前回复结束');
      const ref = identity(), messages = history();
      await saveHistory(context().chat, ref);
      return { messages, chat: { avatar: ref.avatar_url, fileName: ref.file_name } };
    },
    async openConversation({ chat }) {
      if (requestId || changing || script.isGenerating()) throw new Error('请先等待当前回复结束');
      const current = identity();
      if (chat.avatar !== current.avatar_url || typeof chat.fileName !== 'string' || /[\\/\x00]/.test(chat.fileName) || !chat.fileName || ['.', '..'].includes(chat.fileName)) throw new Error('聊天标识不正确');
      const target = { ...current, file_name: chat.fileName };
      const disk = await chatRequest('get', target);
      await context().openCharacterChat(chat.fileName);
      // A new study segment starts empty, even if the character has a greeting.
      if (!Array.isArray(disk) || disk.length < 2) context().chat.splice(0, context().chat.length);
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
    async generate({ id, text, study, automatic = false, regeneration }) {
      if (requestId || changing || script.isGenerating()) throw new Error('对话正在生成');
      const expected = identity();
      let original;
      if (regeneration) {
        const index = targetIndex(regeneration), message = context().chat[index];
        if (index !== context().chat.length - 1 || message.is_user) throw new Error('只能重新生成最新一条角色回复');
        original = structuredClone(context().chat);
      }
      requestId = id; last = ''; cancelled = false;
      const ctx = context();
      const prefix = '你正在桌宠中陪伴真实用户学习。角色卡的情节与用户设定属于虚构，不能作为真实学习进度。不要替用户执行软件操作。当前没有摄像头或桌面观察数据。自然回应用户；动作与旁白可保留，真正说出的台词请使用中文双引号“…”包围，方便语音播报。';
      ctx.setExtensionPrompt('friend-study', `${prefix}\n当前状态：${study.mode}；学习主题：${study.topic || '未设置'}；本段学习 ${Math.floor(study.elapsedMs / 60000)} 分钟。${automatic ? '\n此条为休息开场：用角色语气简短鼓励用户休息一次，不要替用户回答。' : ''}`, script.extension_prompt_types.IN_CHAT, 0, false, 0);
      try {
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
