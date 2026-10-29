import { GatewayError } from './errors.mjs';

export const RUNTIME_PROVIDERS = Object.freeze({ claude: 'claude', codex: 'codex', opencode: 'opencode' });
export const RUNTIME_PROFILES = Object.freeze({ readOnly: 'read-only', readOnlyStreaming: 'read-only-streaming' });
const MAX_PROMPT_BYTES = 16 * 1024;
const STREAM_INPUT_MODE = 'claude-stream-json';

/** Contract for a reviewed, provider-specific CLI harness. Implementations return fixed argv, never a shell command. */
export class AgentHarnessAdapter {
  constructor(providerId) {
    if (!Object.hasOwn(RUNTIME_PROVIDERS, providerId)) throw new GatewayError('unknown_provider');
    this.providerId = providerId;
  }

  buildLaunch(_prompt, _profile = RUNTIME_PROFILES.readOnly) {
    throw new GatewayError('adapter_not_implemented');
  }
}

export class ClaudeReadOnlyHarnessAdapter extends AgentHarnessAdapter {
  constructor() { super(RUNTIME_PROVIDERS.claude); }

  buildLaunch(prompt, profile = RUNTIME_PROFILES.readOnly) {
    if (![RUNTIME_PROFILES.readOnly, RUNTIME_PROFILES.readOnlyStreaming].includes(profile)) throw new GatewayError('unsupported_profile');
    if (typeof prompt !== 'string' || prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new GatewayError('invalid_args');
    // Keep user text clearly labeled so leading CLI-looking text is not interpreted as an option.
    const taskPrompt = `ALBERA task:\n${prompt}`;
    // Restricted/safe modes constrain built-in tools and customizations; explicit MCP denial
    // keeps configured MCP tools outside the host process boundary.
    const safeFlags = ['--restricted', '--safe-mode', '--disallowedTools', 'mcp__*', '--permission-mode', 'plan'];
    const args = profile === RUNTIME_PROFILES.readOnlyStreaming
      ? [...safeFlags, '--permission-prompts', 'none', '--print', '--max-turns', '1', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json']
      : [...safeFlags, '--print', '--max-turns', '1', '--no-session-persistence', taskPrompt];
    return Object.freeze({
      profile,
      args: Object.freeze(args),
      ...(profile === RUNTIME_PROFILES.readOnlyStreaming ? { inputMode: STREAM_INPUT_MODE, initialInput: taskPrompt } : {}),
    });
  }
}

const CLAUDE_READ_ONLY = new ClaudeReadOnlyHarnessAdapter();

/** Compatibility facade used by RuntimeGateway; unsupported providers fail closed. */
export function buildProviderLaunch(provider, prompt, profile = RUNTIME_PROFILES.readOnly) {
  if (!Object.hasOwn(RUNTIME_PROVIDERS, provider)) throw new GatewayError('unknown_provider');
  if (provider !== RUNTIME_PROVIDERS.claude) throw new GatewayError('profile_unavailable');
  return CLAUDE_READ_ONLY.buildLaunch(prompt, profile);
}
