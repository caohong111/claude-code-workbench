import fs from 'node:fs/promises';
import path from 'node:path';

const cleanLabel = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : '';

export async function runClaudeControl({ id, action, name, cwd, executablePath, configDirectory, tempDirectory, cacheDirectory, signal, queryFactory, timeoutMs = 25000 }) {
  if (!['reload-skills', 'reload-plugins', 'mcp', 'chrome'].includes(id)) throw new Error('不支持的 Claude 控制操作。');
  if (id === 'mcp' && action === 'reconnect' && (typeof name !== 'string' || !name || name.length > 200)) throw new Error('请选择 MCP 服务器。');
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(path.join(configDirectory, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Claude 配置不是有效 JSON，无法执行控制操作。'); }
  const env = { ...process.env, ...Object.fromEntries(Object.entries(settings.env || {}).filter(([, value]) => typeof value === 'string')),
    CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_TMPDIR: tempDirectory, TEMP: tempDirectory, TMP: tempDirectory,
    XDG_CACHE_HOME: cacheDirectory, DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (id === 'chrome' && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => env[key] === '1') || env.ANTHROPIC_BASE_URL && new URL(env.ANTHROPIC_BASE_URL).hostname !== 'api.anthropic.com')) {
    return { statuses: [], message: '当前使用 API Key、中转站、长期令牌或第三方提供商，官方 Chrome 集成不可用。需要通过 /login 登录 Claude 官方付费账户。' };
  }
  const secrets = Object.entries(env).filter(([key, value]) => /token|secret|password|api.?key|credential/i.test(key) && value?.length >= 6).map(([, value]) => value);
  const redact = value => {
    let result = String(value || '');
    for (const secret of secrets) result = result.split(secret).join('[已隐藏]');
    return result.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 1000);
  };
  const controller = new AbortController();
  let query;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timeout;
  const cancelled = new Promise((_, reject) => {
    const cancel = () => reject(new Error('Claude 控制操作已取消或超时，请重试。'));
    controller.signal.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(abort, timeoutMs);
  });
  cancelled.catch(() => {});
  const input = async function* () {
    if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
  };
  try {
    if (signal?.aborted) throw new Error('Claude 控制操作已取消。');
    const createQuery = queryFactory || (await import('@anthropic-ai/claude-agent-sdk')).query;
    query = createQuery({ prompt: input(), options: {
      cwd, env, pathToClaudeCodeExecutable: executablePath, persistSession: false,
      settingSources: ['user', 'project', 'local'], permissionMode: 'plan', abortController: controller,
      settings: { disableAllHooks: true },
      ...(id === 'reload-skills' ? { strictMcpConfig: true, mcpServers: {} } : {}),
      ...(id === 'chrome' ? { extraArgs: { chrome: null } } : {}),
      canUseTool: async () => ({ behavior: 'deny', message: '此操作仅检查配置，不执行模型工具。' }), stderr: () => {},
    } });
    const operation = async () => {
      if (id === 'reload-skills') {
        if (typeof query.reloadSkills !== 'function') throw new Error('当前 Claude SDK 不支持重新加载技能。');
        const result = await query.reloadSkills();
        return { type: 'text', content: `已重新扫描 ${result.skills?.length || 0} 个技能。${result.skills?.length ? `\n${result.skills.slice(0, 500).map(item => `/${cleanLabel(item.name)}`).join('\n')}` : ''}\n本次使用临时会话检查；后续 Claude 任务会从磁盘加载。` };
      }
      if (id === 'reload-plugins') {
        if (typeof query.reloadPlugins !== 'function') throw new Error('当前 Claude SDK 不支持重新加载插件。');
        const result = await query.reloadPlugins({ holdOnCacheImpact: true });
        return { type: 'text', content: `${result.held ? '检测到缓存影响，本次未应用重新加载' : '已检查插件加载'}：${result.plugins?.length || 0} 个插件、${result.commands?.length || 0} 个命令、${result.agents?.length || 0} 个代理、${result.mcpServers?.length || 0} 个 MCP 服务器。${result.error_count ? `\n发现 ${result.error_count} 个加载错误，请检查插件配置。` : ''}\n本次使用临时会话检查；后续 Claude 任务会从磁盘加载。` };
      }
      if (id === 'mcp' && action === 'reconnect') await query.reconnectMcpServer(name);
      const statuses = await query.mcpServerStatus();
      return { statuses: (statuses || []).filter(item => id !== 'chrome' || /claude.*chrome|chrome.*claude/i.test(item.name)).slice(0, 300).map(item => ({
        name: cleanLabel(item.name), status: ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(item.status) ? item.status : 'pending',
        ...(item.error ? { error: redact(item.error) } : {}), toolCount: item.tools?.length || 0,
      })), message: '本次检测结束；发送任务时会重新建立连接。' };
    };
    return await Promise.race([operation(), cancelled]);
  } catch (error) { throw new Error(redact(error?.message || error)); }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    try { query?.close(); } catch { /* The control transport may already have exited. */ }
    try { await query?.return?.(); } catch { /* Abort has already closed the stream. */ }
  }
}
