# Zed AI Provider Wizard

Auto-discover and manage OpenAI-compatible AI providers (OpenRouter, Ollama, etc.) in Zed with an interactive terminal UI. No more manual JSON editing.

## 🤔 Why This Tool?

Zed lacks an easy way to add OpenAI-compatible APIs and doesn't auto-fetch models. This tool fixes both:

| Task | Manual (Zed only) | With This Tool |
|------|------------------|----------------|
| Add provider | Edit JSON by hand, look up model IDs | Enter URL → auto-fetches all models |
| Configure | Copy-paste with manual capabilities | Interactive multi-select |
| Update/Delete | More JSON editing | Menu-driven, preserves formatting |

**Saves 15-30 mins of JSON editing → 30 seconds in terminal.**

> 📖 See [Zed's official LLM provider docs](https://zed-dev.translate.goog/docs/ai/llm-providers) for the manual configuration process this tool replaces.

## 🚀 Quick Run (Latest Version)

```bash
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git
```

No installation needed! This command always fetches and runs the **latest version** from GitHub.

## Features

- 🚀 **Interactive Menu System** - Full CRUD operations via terminal UI
- 🔍 **Auto-fetch Models** - Automatically discovers available models from API endpoints
- ✏️ **Edit Model Settings** - Modify max_tokens and capabilities for existing models
- 🗑️ **Delete Providers** - Remove providers with confirmation prompts
- 📋 **List Providers** - View all configured providers and their models
- 📝 **JSONC Preservation** - Maintains comments, trailing commas, and formatting
- 🔄 **Smart Merging** - Keeps existing model configurations during updates
- 🔑 **Environment-based API Keys** - Secure key management via environment variables

## Quick Start

### Run Directly from GitHub (No Installation!)

```bash
# Always runs the latest version from the repository
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git
```

**Requirements:** [Bun](https://bun.sh/) must be installed on your system.

**What happens on first run:**
- Downloads the latest code from GitHub
- Installs dependencies automatically
- Caches everything for faster subsequent runs

**Benefits:**
- ✅ No local installation or cloning required
- ✅ Always runs the **latest version** from main branch
- ✅ Internet connection required only for first run
- ✅ Subsequent runs use cached version for speed

### Run Specific Version/Branch/Commit

```bash
# Run from a specific branch (e.g., develop)
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git#develop

# Run from a specific version tag (e.g., v1.0.0)
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git#v1.0.0

# Run from a specific commit hash
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git#abc1234

# To always get the latest version, omit the # suffix:
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git
```

## Alternative Installation Methods

### Local Development

**Clone and run directly:**
```bash
git clone https://github.com/kwanLeeFrmVi/zed-api-util.git
cd zed-api-util
./zed-api.ts
```

### Build Standalone Binary

**Build the standalone executable:**
```bash
cd zed-api-util
bun install
bun run build
./zed-api
```

The bundled `zed-api` executable works offline after build.

## Usage

You'll see:
```
🔧 Zed OpenAI-Compatible Provider Manager

What would you like to do?
  ○ Create/Update provider
  ○ List all providers
  ○ Edit model settings
  ○ Delete provider
  ○ Exit
```

## Operations

### 1. Create/Update Provider

Adds a new provider or updates an existing one with fresh models from the API.

**Flow:**
1. Enter provider name (e.g., "OpenRouter", "Ollama", "LocalAI")
2. Enter API URL (e.g., `https://api.openrouter.ai` or `http://localhost:11434`)
3. Tool auto-fetches models from `{api_url}/v1/models`
4. Select models (interactive multiselect or "all")
5. Set default max_tokens for new models
6. Configuration saved to `~/.config/zed/settings.json`

**Smart Merging:**
- Existing model configurations are preserved
- Only new models get default settings
- API URL is updated if changed

### 2. List All Providers

Displays all configured providers with summary information.

**Output Example:**
```
📋 Configured Providers (2):

────────────────────────────────────────────────────────────────────────────────

🔧 OpenRouter
   URL: https://openrouter.ai/api/v1
   Models: 23

🔧 Ollama
   URL: http://localhost:11434/v1
   Models: 5

────────────────────────────────────────────────────────────────────────────────
```

### 3. Edit Model Settings

Modify settings for existing models without re-fetching from API.

**Flow:**
1. Select provider to edit
2. Select models to modify (multiselect)
3. Choose what to edit:
   - **Max tokens** - Set maximum token limit
   - **Tools capability** - Enable/disable tool/function calling
   - **Images capability** - Enable/disable vision/image support
   - **Parallel tool calls** - Enable/disable parallel function execution
   - **Prompt cache key** - Enable/disable prompt caching
4. Apply changes (preserves JSONC formatting)

**Use Cases:**
- Increase max_tokens for specific models
- Enable vision support for GPT-4 Vision models
- Toggle tool calling for testing
- Batch update multiple models at once

### 4. Delete Provider

Remove a provider and all its models from configuration.

**Flow:**
1. Select provider to delete
2. Review deletion details (shows model count)
3. Confirm deletion (defaults to "No" for safety)
4. Provider removed from `settings.json`

**Safety:**
- Requires explicit confirmation
- Shows impact (number of models affected)
- Preserves JSONC formatting after deletion

## API Key Setup

The tool uses environment variables for API keys (not stored in settings):

```bash
# Format: <PROVIDER_NAME>_API_KEY
export OPENROUTER_API_KEY="your-key-here"
export OLLAMA_API_KEY="your-key-here"
export LOCALAI_API_KEY="your-key-here"
```

Add these to `~/.zshrc` or `~/.bashrc` to persist across sessions.

**Variable Naming:**
- Provider name is uppercased
- Non-alphanumeric characters become underscores
- `_API_KEY` suffix is appended

Examples:
- "OpenRouter" → `OPENROUTER_API_KEY`
- "Local-AI" → `LOCAL_AI_API_KEY`
- "my.custom.api" → `MY_CUSTOM_API_API_KEY`

## Examples

### Complete Workflow Example

```bash
# 1. Add OpenRouter provider
$ zed-api
> Create/Update provider
Provider name: OpenRouter
API URL: https://openrouter.ai/api
✓ Found 156 models
> Interactive selection
[Select: gpt-4, claude-3-opus, llama-3-70b]
Default max_tokens: 8192
✅ Successfully configured provider "OpenRouter" with 3 models!

# 2. List providers to verify
> List all providers
📋 Configured Providers (1):
🔧 OpenRouter - 3 models

# 3. Edit model settings
> Edit model settings
Select provider: OpenRouter
Select models: [gpt-4]
What to edit: Max tokens
New max_tokens: 32000
✅ Updated max_tokens to 32000 for 1 model(s)

# 4. Add local Ollama
> Create/Update provider
Provider name: Ollama
API URL: http://localhost:11434
> Add all models
✅ Successfully configured provider "Ollama" with 5 models!

# 5. Delete a provider
> Delete provider
Select provider: Ollama
Delete "Ollama" with 5 models? No
❌ Deletion cancelled
```

## Technical Details

### Settings File Location
```
~/.config/zed/settings.json
```

### Configuration Structure
```json
{
  "language_models": {
    "openai_compatible": {
      "OpenRouter": {
        "api_url": "https://openrouter.ai/api/v1",
        "available_models": [
          {
            "name": "gpt-4",
            "display_name": "gpt-4",
            "max_tokens": 8192,
            "capabilities": {
              "tools": true,
              "images": false,
              "parallel_tool_calls": false,
              "prompt_cache_key": false
            }
          }
        ]
      }
    }
  }
}
```

### URL Normalization
- Trailing slashes removed
- `/v1` suffix added if not present
- Examples:
  - `https://api.example.com/` → `https://api.example.com/v1`
  - `http://localhost:11434` → `http://localhost:11434/v1`
  - `https://api.openai.com/v1` → `https://api.openai.com/v1` (unchanged)

### Model Display Names
- Derived from model ID by taking last path segment
- Examples:
  - `anthropic/claude-3-opus` → `claude-3-opus`
  - `gpt-4` → `gpt-4`
  - `meta-llama/llama-3-70b` → `llama-3-70b`

## Troubleshooting

### `bunx` from GitHub

**First run is slow:**
- Dependencies are downloaded and cached on first execution
- Subsequent runs are much faster using the cached version

**Want to update to latest version:**
```bash
# Force Bun to download the latest version (clears cache)
bunx --bun https://github.com/kwanLeeFrmVi/zed-api-util.git

# Or manually clear Bun's cache
rm -rf ~/.bun/install/cache/github.com/kwanLeeFrmVi/zed-api-util
bunx https://github.com/kwanLeeFrmVi/zed-api-util.git
```

**Offline usage:**
- After first run, `bunx` uses cached version
- To ensure offline availability, run once while online
- For fully offline usage, clone the repo and use `./zed-api.ts`

**Offline usage:**
- After first run, `bunx` uses cached version
- To ensure offline availability, run once while online
- For fully offline usage, clone the repo and use `./zed-api.ts`

**Bun not installed:**
```bash
# Install Bun (macOS/Linux)
curl -fsSL https://bun.sh/install | bash

# Or via Homebrew
brew install oven-sh/bun/bun
```

### Local execution issues

**Command not found (local builds):**
Not applicable - run from project directory with `./zed-api` or `./zed-api.ts`

### Authentication errors
```bash
# The tool will show you the exact variable name needed
export OPENROUTER_API_KEY="sk-or-v1-..."

# Verify it's set
env | grep API_KEY

# Make it permanent
echo 'export OPENROUTER_API_KEY="sk-or-v1-..."' >> ~/.zshrc
source ~/.zshrc
```

### No models found
- Verify API URL is correct and accessible
- Check endpoint returns OpenAI-compatible format:
  ```bash
  curl -H "Authorization: Bearer $YOUR_API_KEY" https://api.example.com/v1/models
  # Expected: {"data": [{"id": "model-name", ...}]}
  ```
- Some providers use `{"models": [...]}` instead of `{"data": [...]}` - both work

### Settings file not found
```bash
# Verify Zed config directory exists
ls -ld ~/.config/zed

# If missing, create it
mkdir -p ~/.config/zed
echo '{}' > ~/.config/zed/settings.json
```

### JSONC formatting issues
- The tool uses `jsonc-parser` to preserve:
  - Comments (both `//` and `/* */`)
  - Trailing commas
  - Original indentation (2 spaces)
- If formatting breaks, backup and restore:
  ```bash
  cp ~/.config/zed/settings.json ~/.config/zed/settings.json.bak
  # If needed: cp ~/.config/zed/settings.json.bak ~/.config/zed/settings.json
  ```

## Development

### Project Structure
```
api-util/
├── zed-api.ts       # Source TypeScript file (with shebang)
├── zed-api          # Bundled standalone executable (gitignored)
├── package.json     # Dependencies and build script
├── bun.lock         # Lock file
├── .gitignore       # Excludes node_modules/ and zed-api
└── README.md        # This file
```

### Dependencies
- `jsonc-parser` - JSONC parsing with formatting preservation
- `@clack/prompts` - Interactive terminal UI components
- `@types/bun` - TypeScript support for Bun runtime

**Note:** Dependencies are bundled into the executable. `node_modules/` only needed during build.

### Building

To rebuild the standalone executable:
```bash
cd zed-api-util
bun install  # Only if dependencies changed
bun run build
```

### Running Locally
```bash
# Run source file directly
./zed-api.ts

# Or during development with Bun
bun run zed-api.ts

# Or use the compiled binary (after building)
./zed-api
```

## License

MIT
