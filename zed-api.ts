#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as jsonc from "jsonc-parser";
import {
  confirm,
  select,
  multiselect,
  text,
  spinner,
  note,
  intro,
  outro,
} from "@clack/prompts";

interface Model {
  id: string;
  [key: string]: any;
}

interface ModelsResponse {
  data?: Model[];
  models?: Model[];
}

interface AvailableModel {
  name: string;
  display_name: string;
  max_tokens: number;
  capabilities: {
    tools: boolean;
    images: boolean;
    parallel_tool_calls: boolean;
    prompt_cache_key: boolean;
  };
}

interface Provider {
  api_url: string;
  available_models: AvailableModel[];
}

type ModelCapabilities = AvailableModel["capabilities"];

type OpenRouterModel = {
  id: string;
  canonical_slug?: string | null;
  name?: string | null;
  description?: string | null;
  context_length?: number | null;
  supported_parameters?: string[] | null;
  architecture?: {
    modality?: string | null;
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
  } | null;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean | null;
  } | null;
};

let openRouterModelsCache: OpenRouterModel[] | null = null;
let openRouterModelsLoading: Promise<OpenRouterModel[]> | null = null;

function toBool(value: any): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function normalizeModelIdForMatch(modelId: string): string {
  // Drop OpenRouter-style variants like ":free", ":nitro", etc.
  const base = modelId.split(":")[0];
  return base.trim().toLowerCase();
}

function modelIdSuffix(modelId: string): string {
  const normalized = normalizeModelIdForMatch(modelId);
  const parts = normalized.split("/");
  return parts.length > 1 ? parts[parts.length - 1] : normalized;
}

function tokenizeId(modelId: string): string[] {
  return normalizeModelIdForMatch(modelId)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (openRouterModelsCache) return openRouterModelsCache;
  if (openRouterModelsLoading) return openRouterModelsLoading;

  openRouterModelsLoading = (async () => {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models fetch failed: HTTP ${response.status}`);
    }

    const json = (await response.json()) as { data?: OpenRouterModel[] };
    const models = Array.isArray(json?.data) ? json.data : [];
    openRouterModelsCache = models;
    return models;
  })();

  try {
    return await openRouterModelsLoading;
  } finally {
    openRouterModelsLoading = null;
  }
}

function findBestOpenRouterModelMatch(
  modelId: string,
  openRouterModels: OpenRouterModel[],
): OpenRouterModel | null {
  const normalized = normalizeModelIdForMatch(modelId);
  const suffix = modelIdSuffix(modelId);
  const tokens = tokenizeId(modelId);

  let best: { score: number; model: OpenRouterModel } | null = null;

  for (const m of openRouterModels) {
    const mId = normalizeModelIdForMatch(m.id);
    const mSuffix = modelIdSuffix(m.id);

    let score = 0;

    if (mId === normalized) score += 1000;
    if (mSuffix === suffix) score += 500;
    if (mId.includes(normalized) || normalized.includes(mId)) score += 150;
    if (mSuffix.includes(suffix) || suffix.includes(mSuffix)) score += 75;

    // Token overlap to catch close-but-not-identical names.
    const overlap = jaccard(tokens, tokenizeId(m.id));
    score += overlap * 100;

    // Bonus if the model name/slug contains the suffix.
    const name = (m.name || "").toLowerCase();
    const slug = (m.canonical_slug || "").toLowerCase();
    if (name.includes(suffix) || slug.includes(suffix)) score += 25;

    if (!best || score > best.score) best = { score, model: m };
  }

  // Threshold to avoid wild mismatches.
  if (!best || best.score < 250) return null;
  return best.model;
}

function capabilitiesFromSupportedParameters(
  supportedParameters?: unknown,
): Partial<ModelCapabilities> {
  if (!Array.isArray(supportedParameters)) return {};
  const params = new Set(supportedParameters.map((p) => String(p)));
  const tools = params.has("tools") || params.has("tool_choice");
  const parallel = params.has("parallel_tool_calls");
  return {
    tools,
    parallel_tool_calls: parallel,
  };
}

function capabilitiesFromArchitecture(architecture?: any): Partial<ModelCapabilities> {
  const input = architecture?.input_modalities;
  if (!Array.isArray(input)) return {};

  // Zed's "images" flag is best mapped to "supports image input".
  const images = input.map(String).includes("image");
  return { images };
}

function inferCapabilitiesFromProviderModel(model: any): Partial<ModelCapabilities> {
  // Some providers return a direct boolean capabilities object.
  if (model && typeof model === "object" && model.capabilities) {
    const c = model.capabilities;
    return {
      tools: toBool(c.tools),
      images: toBool(c.images),
      parallel_tool_calls: toBool(c.parallel_tool_calls),
      prompt_cache_key: toBool(c.prompt_cache_key),
    };
  }

  // OpenRouter-like metadata: supported_parameters + architecture.
  return {
    ...capabilitiesFromSupportedParameters(model?.supported_parameters),
    ...capabilitiesFromArchitecture(model?.architecture),
  };
}

function finalizeCapabilities(
  partial: Partial<ModelCapabilities>,
  defaults: ModelCapabilities,
): ModelCapabilities {
  return {
    tools: partial.tools ?? defaults.tools,
    images: partial.images ?? defaults.images,
    parallel_tool_calls: partial.parallel_tool_calls ?? defaults.parallel_tool_calls,
    prompt_cache_key: partial.prompt_cache_key ?? defaults.prompt_cache_key,
  };
}

async function inferModelSettings(
  modelId: string,
  providerModel: any,
  defaultMaxTokens: number,
): Promise<{ capabilities: ModelCapabilities; max_tokens: number }> {
  const defaultCapabilities: ModelCapabilities = {
    tools: true,
    images: false,
    parallel_tool_calls: false,
    prompt_cache_key: false,
  };

  const fromProvider = inferCapabilitiesFromProviderModel(providerModel);
  const providerHasSignal = Object.values(fromProvider).some(
    (v) => typeof v === "boolean",
  );

  // If the provider includes capabilities signals, trust them (and only fallback if
  // there are still unknowns we care about).
  let capabilities = finalizeCapabilities(fromProvider, defaultCapabilities);
  let maxTokens = defaultMaxTokens;

  // Cap max_tokens if provider advertises a max_completion_tokens.
  const providerMax = providerModel?.top_provider?.max_completion_tokens;
  if (typeof providerMax === "number" && providerMax > 0) {
    maxTokens = Math.min(maxTokens, providerMax);
  }

  const stillDefaulted =
    !providerHasSignal &&
    capabilities.tools === defaultCapabilities.tools &&
    capabilities.images === defaultCapabilities.images;

  if (!stillDefaulted) {
    return { capabilities, max_tokens: maxTokens };
  }

  // Fallback: best-effort lookup using OpenRouter's public model registry.
  // This does not require an API key.
  try {
    const openRouterModels = await fetchOpenRouterModels();
    const match = findBestOpenRouterModelMatch(modelId, openRouterModels);
    if (!match) return { capabilities, max_tokens: maxTokens };

    const fromOR: Partial<ModelCapabilities> = {
      ...capabilitiesFromSupportedParameters(match.supported_parameters),
      ...capabilitiesFromArchitecture(match.architecture),
      // OpenRouter does not expose a stable prompt-cache-key capability.
      prompt_cache_key: false,
    };
    capabilities = finalizeCapabilities(fromOR, capabilities);

    const orMax = match.top_provider?.max_completion_tokens;
    if (typeof orMax === "number" && orMax > 0) {
      maxTokens = Math.min(maxTokens, orMax);
    }
  } catch {
    // Ignore network / parsing errors and keep defaults.
  }

  return { capabilities, max_tokens: maxTokens };
}

const ZED_SETTINGS_PATH = join(homedir(), ".config/zed/settings.json");

function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function getModelsEndpoint(apiUrl: string): string {
  const normalized = normalizeApiUrl(apiUrl);
  return `${normalized}/models`;
}

function deriveEnvVarName(providerName: string): string {
  return `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function deriveDisplayName(modelId: string): string {
  const parts = modelId.split("/");
  return parts.length > 1 ? parts[parts.length - 1] : modelId;
}

function bestEffortDisplayName(modelId: string, providerModel: any): string {
  // If we have a provider model object, attempt to use nicer names.
  const name = providerModel?.name;
  if (typeof name === "string" && name.trim().length > 0) return name.trim();
  const display = providerModel?.display_name;
  if (typeof display === "string" && display.trim().length > 0)
    return display.trim();
  return deriveDisplayName(modelId);
}

async function fetchModels(
  endpoint: string,
  apiKey?: string,
  providerName?: string,
): Promise<Model[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const s = spinner();
  s.start(`Fetching models from ${endpoint}`);

  try {
    const response = await fetch(endpoint, { headers });

    if (!response.ok) {
      s.stop(`Failed: HTTP ${response.status}`);

      if ((response.status === 401 || response.status === 403) && !apiKey) {
        // Offer retry with API key
        const shouldRetry = await confirm({
          message: "API key required. Would you like to provide one now?",
          initialValue: true,
        });

        if (typeof shouldRetry === "symbol" || !shouldRetry) {
          console.error("\n⚠️  Cannot proceed without API key.\n");
          process.exit(1);
        }

        const apiKeyInput = await text({
          message: "Enter API key:",
          placeholder: "sk-...",
          validate: (value) => {
            if (!value) return "API key is required to continue";
            if (/\s/.test(value)) return "API key should not contain spaces";
          },
        });

        if (typeof apiKeyInput === "symbol") {
          process.exit(1);
        }

        const newApiKey = apiKeyInput as string;

        // Load into current process
        if (providerName) {
          const envVarName = deriveEnvVarName(providerName);
          process.env[envVarName] = newApiKey;

          // Show copy-paste command
          const shell = process.env.SHELL || "";
          const rcFile = shell.includes("zsh") ? "~/.zshrc" : "~/.bashrc";

          note(
            `To persist this key across sessions, add to ${rcFile}:\n\n` +
              `  export ${envVarName}="${newApiKey}"\n\n` +
              `Then run: source ${rcFile}`,
            "💾 Save API Key"
          );
        }

        console.log(`✅ API key loaded for this session\n`);

        // Retry fetch with new key
        return fetchModels(endpoint, newApiKey, providerName);
      }

      if ((response.status === 401 || response.status === 403) && apiKey) {
        console.error(
          `\n⚠️  API key was provided but authentication failed.\n` +
            `Please verify your API key is correct.\n`
        );
        process.exit(1);
      }

      const preview = await response.text();
      console.error(`Response preview: ${preview.slice(0, 2048)}`);
      process.exit(1);
    }

    const data: ModelsResponse = await response.json();
    s.stop("Models fetched successfully");

    // Handle both OpenAI-style {data: [...]} and direct {models: [...]}
    const models = data.data || data.models || [];

    if (!Array.isArray(models) || models.length === 0) {
      console.error("⚠️  No models found in response");
      console.error(`Response: ${JSON.stringify(data).slice(0, 2048)}`);
      process.exit(1);
    }

    return models.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    s.stop("Failed to fetch models");
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

function readZedSettings(): { text: string; data: any } {
  if (!existsSync(ZED_SETTINGS_PATH)) {
    console.error(`⚠️  Zed settings not found at: ${ZED_SETTINGS_PATH}`);
    process.exit(1);
  }

  const text = readFileSync(ZED_SETTINGS_PATH, "utf-8");
  const data = jsonc.parse(text);
  return { text, data };
}

function writeZedSettings(text: string) {
  writeFileSync(ZED_SETTINGS_PATH, text, "utf-8");
}

async function addProvider() {
  // Prompt for provider name
  const providerName = await text({
    message: "Provider name:",
    placeholder: "e.g., OpenRouter, Ollama, LocalAI",
    validate: (value) => {
      if (!value) return "Provider name is required";
    },
  });

  if (typeof providerName === "symbol") {
    return;
  }

  // Check if provider already exists
  const { data: settings } = readZedSettings();
  const existingProviders = settings?.language_models?.openai_compatible || {};

  if (existingProviders[providerName as string]) {
    console.log(
      `\n⚠️  Provider "${providerName}" already exists. Use "Modify provider" to update it.\n`,
    );
    return;
  }

  // Prompt for API URL
  const apiUrl = await text({
    message: "API URL:",
    placeholder: "e.g., https://api.example.com or http://localhost:11434",
    validate: (value) => {
      if (!value) return "API URL is required";
      if (!value.startsWith("http://") && !value.startsWith("https://")) {
        return "URL must start with http:// or https://";
      }
    },
  });

  if (typeof apiUrl === "symbol") {
    return;
  }

  const normalizedApiUrl = normalizeApiUrl(apiUrl as string);
  const modelsEndpoint = getModelsEndpoint(apiUrl as string);
  const envVarName = deriveEnvVarName(providerName as string);
  let apiKey = process.env[envVarName];

  if (!apiKey) {
    const apiKeyInput = await text({
      message: `API key for ${providerName} (optional, press Enter to skip):`,
      placeholder: "sk-...",
      validate: (value) => {
        // Allow empty (optional)
        if (!value) return undefined;
        // Basic validation: no whitespace
        if (/\s/.test(value)) return "API key should not contain spaces";
      },
    });

    if (typeof apiKeyInput !== "symbol" && apiKeyInput) {
      apiKey = apiKeyInput as string;
      // Load into current process for immediate use
      process.env[envVarName] = apiKey;

      // Show copy-paste command
      const shell = process.env.SHELL || "";
      const rcFile = shell.includes("zsh") ? "~/.zshrc" : "~/.bashrc";

      note(
        `Your API key is loaded for this session.\n\n` +
        `To persist it across sessions, add this to ${rcFile}:\n\n` +
        `  export ${envVarName}="${apiKey}"\n\n` +
        `Then run: source ${rcFile}`,
        "💾 Save API Key"
      );
    }
  }

  console.log(`\n📝 Provider: ${providerName}`);
  console.log(`🔗 API URL: ${normalizedApiUrl}`);
  console.log(`🔑 API Key: ${apiKey ? "✓ Set" : "✗ Not set"}\n`);

  // Fetch models
  const models = await fetchModels(modelsEndpoint, apiKey, providerName as string);
  console.log(`\n✓ Found ${models.length} models\n`);

  // Select models
  const selectionMode = await select({
    message: "How do you want to select models?",
    options: [
      {
        value: "interactive",
        label: "Interactive selection (pick specific models)",
      },
      { value: "filter", label: "Filter then select (search by keyword)" },
      { value: "all", label: "Add all models" },
    ],
  });

  if (typeof selectionMode === "symbol") {
    return;
  }

  let selectedModelIds: string[];
  let modelsToShow = models;

  // Apply filter if requested
  if (selectionMode === "filter") {
    const filterText = await text({
      message: "Filter models (case-insensitive, partial match):",
      placeholder: "e.g., gpt, claude, llama",
      validate: (value) => {
        if (!value) return "Filter text is required";
      },
    });

    if (typeof filterText === "symbol") {
      return;
    }

    const filter = (filterText as string).toLowerCase();
    modelsToShow = models.filter((m) => m.id.toLowerCase().includes(filter));

    if (modelsToShow.length === 0) {
      console.log(`\n⚠️  No models match filter "${filterText}"\n`);
      return;
    }

    console.log(`\n✓ Found ${modelsToShow.length} models matching "${filterText}"\n`);
  }

  if (selectionMode === "all") {
    selectedModelIds = models.map((m) => m.id);
    console.log(`\n✓ Selected all ${selectedModelIds.length} models`);
  } else {
    const choices = modelsToShow.map((m) => ({
      value: m.id,
      label: m.id,
      hint: deriveDisplayName(m.id),
    }));

    const selected = await multiselect({
      message: "Select models to add (use space to toggle, enter to confirm):",
      options: choices,
      required: true,
    });

    if (typeof selected === "symbol") {
      return;
    }

    selectedModelIds = selected as string[];
  }

  if (selectedModelIds.length === 0) {
    console.log("⚠️  No models selected");
    return;
  }

  console.log(`\n✓ Selected ${selectedModelIds.length} models`);

  // Ask for default max_tokens
  const maxTokensInput = await text({
    message: "Default max_tokens for models:",
    placeholder: "8192",
    defaultValue: "8192",
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return "Must be a positive number";
    },
  });

  if (typeof maxTokensInput === "symbol") {
    return;
  }

  const defaultMaxTokens = parseInt(maxTokensInput as string, 10) || 8192;

  // Build available_models array
  const availableModels: AvailableModel[] = [];
  for (const modelId of selectedModelIds) {
    const providerModel = models.find((m) => m.id === modelId);
    const inferred = await inferModelSettings(modelId, providerModel, defaultMaxTokens);
    availableModels.push({
      name: modelId,
      display_name: bestEffortDisplayName(modelId, providerModel),
      max_tokens: inferred.max_tokens,
      capabilities: inferred.capabilities,
    });
  }

  const newProvider: Provider = {
    api_url: normalizedApiUrl,
    available_models: availableModels,
  };

  // Read settings again for writing
  const { text: settingsText } = readZedSettings();
  const settingsData = jsonc.parse(settingsText);

  // Update settings using jsonc-parser to preserve formatting
  const path = ["language_models", "openai_compatible", providerName as string];

  // Ensure parent paths exist
  let updatedText = settingsText;

  if (!settingsData.language_models) {
    updatedText = jsonc.applyEdits(
      updatedText,
      jsonc.modify(
        updatedText,
        ["language_models"],
        {},
        {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        },
      ),
    );
  }

  const settingsAfterLM = jsonc.parse(updatedText);
  if (!settingsAfterLM.language_models.openai_compatible) {
    updatedText = jsonc.applyEdits(
      updatedText,
      jsonc.modify(
        updatedText,
        ["language_models", "openai_compatible"],
        {},
        {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        },
      ),
    );
  }

  // Now set the provider
  const edits = jsonc.modify(updatedText, path, newProvider, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });

  updatedText = jsonc.applyEdits(updatedText, edits);

  // Write back
  writeZedSettings(updatedText);

  console.log(
    `\n✅ Successfully configured provider "${providerName}" with ${availableModels.length} models!`,
  );

  if (!apiKey) {
    console.log(`\n💡 To use this provider, add to your shell rc file:\n`);
    console.log(`   export ${envVarName}="your-api-key-here"\n`);
  }
}

async function addModelsToProvider(providerName: string) {
  const { text: settingsText, data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const provider = providers[providerName];

  if (!provider) {
    console.log(`\n⚠️  Provider "${providerName}" not found\n`);
    return;
  }

  // Get existing models
  const existingModels = provider.available_models || [];
  const existingModelNames = new Set<string>(
    existingModels.map((m: AvailableModel) => m.name),
  );

  // Fetch models from API
  const modelsEndpoint = getModelsEndpoint(provider.api_url);
  const envVarName = deriveEnvVarName(providerName);
  const apiKey = process.env[envVarName];

  const fetchedModels = await fetchModels(modelsEndpoint, apiKey, providerName);
  console.log(`\n✓ Found ${fetchedModels.length} models from API\n`);

  // Ask if user wants to filter
  const useFilter = await confirm({
    message: "Filter models by keyword before selection?",
    initialValue: false,
  });

  if (typeof useFilter === "symbol") {
    return;
  }

  let modelsToShow = fetchedModels;

  if (useFilter) {
    const filterText = await text({
      message: "Filter models (case-insensitive, partial match):",
      placeholder: "e.g., gpt, claude, llama",
      validate: (value) => {
        if (!value) return "Filter text is required";
      },
    });

    if (typeof filterText === "symbol") {
      return;
    }

    const filter = (filterText as string).toLowerCase();
    modelsToShow = fetchedModels.filter((m) =>
      m.id.toLowerCase().includes(filter),
    );

    if (modelsToShow.length === 0) {
      console.log(`\n⚠️  No models match filter "${filterText}"\n`);
      return;
    }

    console.log(`\n✓ Found ${modelsToShow.length} models matching "${filterText}"\n`);
  }

  // Create options with existing models pre-selected
  const choices = modelsToShow.map((m) => ({
    value: m.id,
    label: m.id,
    hint: existingModelNames.has(m.id)
      ? "✓ Currently active"
      : deriveDisplayName(m.id),
  }));

  // Pre-select existing models (only from filtered list)
  const initialSelected = modelsToShow
    .filter((m) => existingModelNames.has(m.id))
    .map((m) => m.id);

  const selected = await multiselect({
    message:
      "Select models (existing models are pre-selected, space to toggle):",
    options: choices,
    initialValues: initialSelected,
  });

  if (typeof selected === "symbol") {
    return;
  }

  const selectedModelIds = selected as string[];
  const selectedSet = new Set(selectedModelIds);

  // Calculate changes (need to account for filtered out existing models)
  const additions = selectedModelIds.filter(
    (id) => !existingModelNames.has(id),
  );

  // Only consider removals from models that were in the filtered view
  const modelsInView = new Set(modelsToShow.map((m) => m.id));
  const removals = Array.from(existingModelNames).filter(
    (id: string) => modelsInView.has(id) && !selectedSet.has(id),
  );

  // Check if no changes
  if (additions.length === 0 && removals.length === 0) {
    console.log("\n⚠️  No changes made\n");
    return;
  }

  // Show confirmation
  console.log("\n📝 Changes:");
  if (additions.length > 0) {
    console.log(`\n  ➕ Adding ${additions.length} model(s):`);
    additions.forEach((id) => console.log(`     - ${id}`));
  }
  if (removals.length > 0) {
    console.log(`\n  ➖ Removing ${removals.length} model(s):`);
    removals.forEach((id) => console.log(`     - ${id}`));
  }
  console.log("");

  const confirmed = await confirm({
    message: "Apply these changes?",
    initialValue: true,
  });

  if (typeof confirmed === "symbol" || !confirmed) {
    console.log("\n❌ Changes cancelled\n");
    return;
  }

  // Ask for default max_tokens for new models (only if adding)
  let defaultMaxTokens = 8192;
  if (additions.length > 0) {
    const maxTokensInput = await text({
      message: "Default max_tokens for new models:",
      placeholder: "8192",
      defaultValue: "8192",
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return "Must be a positive number";
      },
    });

    if (typeof maxTokensInput === "symbol") {
      return;
    }

    defaultMaxTokens = parseInt(maxTokensInput as string, 10) || 8192;
  }

  // Build new available_models array
  const existingModelsMap = new Map<string, AvailableModel>();
  for (const model of existingModels) {
    existingModelsMap.set(model.name, model);
  }

  // Combine: selected models + existing models that weren't in the filtered view
  const removalsSet = new Set(removals);
  const allModelIds = new Set([
    ...selectedModelIds,
    ...Array.from(existingModelNames).filter(
      (id: string) => !modelsInView.has(id), // Keep existing models not in filtered view
    ),
  ]);

  const availableModels: AvailableModel[] = [];
  for (const modelId of Array.from(allModelIds)) {
    const existing = existingModelsMap.get(modelId);
    if (existing && !removalsSet.has(modelId)) {
      // Preserve settings for existing models (unless explicitly removed)
      availableModels.push(existing);
      continue;
    }

    if (removalsSet.has(modelId)) continue;

    const providerModel = fetchedModels.find((m) => m.id === modelId);
    const inferred = await inferModelSettings(modelId, providerModel, defaultMaxTokens);
    availableModels.push({
      name: modelId,
      display_name: bestEffortDisplayName(modelId, providerModel),
      max_tokens: inferred.max_tokens,
      capabilities: inferred.capabilities,
    });
  }

  // Update settings
  const path = [
    "language_models",
    "openai_compatible",
    providerName,
    "available_models",
  ];
  const edits = jsonc.modify(settingsText, path, availableModels, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });

  const updatedText = jsonc.applyEdits(settingsText, edits);
  writeZedSettings(updatedText);

  console.log(`\n✅ Successfully updated provider "${providerName}"`);
  if (additions.length > 0) {
    console.log(`   ➕ Added ${additions.length} model(s)`);
  }
  if (removals.length > 0) {
    console.log(`   ➖ Removed ${removals.length} model(s)`);
  }
  console.log("");
}

async function listProviders() {
  const { data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n📭 No providers configured\n");
    console.log("💡 Use 'Add provider' to add your first provider\n");
    return;
  }

  console.log(`\n📋 Configured Providers (${providerNames.length}):\n`);
  console.log("─".repeat(80));

  for (const name of providerNames) {
    const provider = providers[name];
    const modelCount = provider.available_models?.length || 0;
    console.log(`\n🔧 ${name}`);
    console.log(`   URL: ${provider.api_url}`);
    console.log(`   Models: ${modelCount}`);
  }

  console.log("\n" + "─".repeat(80) + "\n");
}

async function editModelSettings(providerName?: string) {
  const { text: settingsText, data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n⚠️  No providers configured. Create a provider first.\n");
    return;
  }

  // Step 1: Select provider (skip if provided)
  let selectedProvider = providerName;

  if (!selectedProvider) {
    const result = await select({
      message: "Select provider to edit:",
      options: providerNames.map((name) => ({
        value: name,
        label: name,
        hint: `${providers[name].available_models?.length || 0} models`,
      })),
    });

    if (typeof result === "symbol") {
      return;
    }

    selectedProvider = result as string;
  }

  const provider = providers[selectedProvider];
  const models = provider.available_models || [];

  if (models.length === 0) {
    console.log("\n⚠️  No models in this provider.\n");
    return;
  }

  // Step 2: Select models to edit
  const selectedModels = await multiselect({
    message: "Select models to edit (space to toggle, enter to confirm):",
    options: models.map((m: AvailableModel) => ({
      value: m.name,
      label: m.display_name,
      hint: `${m.max_tokens} tokens`,
    })),
    required: true,
  });

  if (typeof selectedModels === "symbol") {
    return;
  }

  const modelNames = selectedModels as string[];

  if (modelNames.length === 0) {
    console.log("\n⚠️  No models selected.\n");
    return;
  }

  // Step 3: Choose what to edit
  const editAction = await select({
    message: "What do you want to edit?",
    options: [
      { value: "max_tokens", label: "Max tokens" },
      { value: "tools", label: "Tools capability" },
      { value: "images", label: "Images capability" },
      { value: "parallel_tool_calls", label: "Parallel tool calls capability" },
      { value: "prompt_cache_key", label: "Prompt cache key capability" },
    ],
  });

  if (typeof editAction === "symbol") {
    return;
  }

  let updatedText = settingsText;

  // Step 4: Apply changes
  if (editAction === "max_tokens") {
    const newMaxTokens = await text({
      message: "New max_tokens value:",
      placeholder: "8192",
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return "Must be a positive number";
      },
    });

    if (typeof newMaxTokens === "symbol") {
      return;
    }

    const tokenValue = parseInt(newMaxTokens as string, 10);

    for (const modelName of modelNames) {
      const modelIndex = models.findIndex(
        (m: AvailableModel) => m.name === modelName,
      );
      const path = [
        "language_models",
        "openai_compatible",
        selectedProvider,
        "available_models",
        modelIndex,
        "max_tokens",
      ];

      const edits = jsonc.modify(updatedText, path, tokenValue, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updatedText = jsonc.applyEdits(updatedText, edits);
    }

    console.log(
      `\n✅ Updated max_tokens to ${tokenValue} for ${modelNames.length} model(s)\n`,
    );
  } else {
    // Capability toggle
    const currentValue = models.find(
      (m: AvailableModel) => m.name === modelNames[0],
    )?.capabilities?.[editAction as keyof AvailableModel["capabilities"]];

    const newValue = await confirm({
      message: `Enable ${editAction}?`,
      initialValue: currentValue ?? false,
    });

    if (typeof newValue === "symbol") {
      return;
    }

    for (const modelName of modelNames) {
      const modelIndex = models.findIndex(
        (m: AvailableModel) => m.name === modelName,
      );
      const path = [
        "language_models",
        "openai_compatible",
        selectedProvider,
        "available_models",
        modelIndex,
        "capabilities",
        editAction as string,
      ];

      const edits = jsonc.modify(updatedText, path, newValue, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updatedText = jsonc.applyEdits(updatedText, edits);
    }

    console.log(
      `\n✅ Set ${editAction} to ${newValue} for ${modelNames.length} model(s)\n`,
    );
  }

  writeZedSettings(updatedText);
}

async function deleteProvider(providerName?: string) {
  const { text: settingsText, data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n📭 No providers to delete\n");
    return;
  }

  // Step 1: Select provider (skip if provided)
  let selectedProvider = providerName;

  if (!selectedProvider) {
    const result = await select({
      message: "Select provider to delete:",
      options: providerNames.map((name) => ({
        value: name,
        label: name,
        hint: `${providers[name].available_models?.length || 0} models`,
      })),
    });

    if (typeof result === "symbol") {
      return;
    }

    selectedProvider = result as string;
  }

  const provider = providers[selectedProvider];
  const modelCount = provider.available_models?.length || 0;

  // Step 2: Confirm deletion
  const confirmed = await confirm({
    message: `Delete provider "${selectedProvider}" with ${modelCount} model(s)?`,
    initialValue: false,
  });

  if (typeof confirmed === "symbol" || !confirmed) {
    console.log("\n❌ Deletion cancelled\n");
    return;
  }

  // Step 3: Delete using jsonc-parser
  const path = ["language_models", "openai_compatible", selectedProvider];
  const edits = jsonc.modify(settingsText, path, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });

  const updatedText = jsonc.applyEdits(settingsText, edits);
  writeZedSettings(updatedText);

  console.log(`\n✅ Successfully deleted provider "${selectedProvider}"\n`);
}

async function renameProvider(oldName: string) {
  const { text: settingsText, data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};

  // Prompt for new name
  const newName = await text({
    message: "New provider name:",
    placeholder: oldName,
    validate: (value) => {
      if (!value) return "Provider name is required";
      if (value === oldName) return "Name unchanged";
      if (providers[value]) return "Provider name already exists";
    },
  });

  if (typeof newName === "symbol") {
    return;
  }

  // Confirm rename
  const confirmed = await confirm({
    message: `Rename "${oldName}" to "${newName}"?`,
    initialValue: true,
  });

  if (typeof confirmed === "symbol" || !confirmed) {
    console.log("\n❌ Rename cancelled\n");
    return;
  }

  // Copy to new key
  const path = ["language_models", "openai_compatible", newName as string];
  let updatedText = jsonc.applyEdits(
    settingsText,
    jsonc.modify(settingsText, path, providers[oldName], {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );

  // Delete old key
  const deletePath = ["language_models", "openai_compatible", oldName];
  updatedText = jsonc.applyEdits(
    updatedText,
    jsonc.modify(updatedText, deletePath, undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );

  writeZedSettings(updatedText);
  console.log(`\n✅ Successfully renamed "${oldName}" to "${newName}"\n`);
}

async function modifyProviderMenu() {
  const { data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n⚠️  No providers configured.\n");
    return;
  }

  // Step 1: Select provider
  const providerName = await select({
    message: "Select provider to modify:",
    options: providerNames.map((name) => ({
      value: name,
      label: name,
      hint: `${providers[name].available_models?.length || 0} models`,
    })),
  });

  if (typeof providerName === "symbol") {
    return;
  }

  // Step 2: Show sub-menu
  while (true) {
    console.log("");
    const action = await select({
      message: `Modify "${providerName}" - Select action:`,
      options: [
        { value: "add-models", label: "Add/Remove models" },
        { value: "modify-models", label: "Modify model settings" },
        { value: "rename", label: "Rename provider" },
        { value: "delete", label: "Delete provider" },
        { value: "back", label: "Back to main menu" },
      ],
    });

    if (typeof action === "symbol" || action === "back") {
      break;
    }

    switch (action) {
      case "add-models":
        await addModelsToProvider(providerName as string);
        break;
      case "modify-models":
        await editModelSettings(providerName as string);
        break;
      case "rename":
        await renameProvider(providerName as string);
        // If renamed, exit sub-menu since provider name changed
        break;
      case "delete":
        await deleteProvider(providerName as string);
        // If deleted, exit sub-menu
        break;
    }

    // Exit sub-menu after rename or delete
    if (action === "rename" || action === "delete") {
      break;
    }
  }
}

async function mainMenu() {
  while (true) {
    console.log("");
    const action = await select({
      message: "What would you like to do?",
      options: [
        { value: "add", label: "Add provider" },
        { value: "modify", label: "Modify provider" },
        { value: "list", label: "List all providers" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (typeof action === "symbol" || action === "exit") {
      outro("👋 Goodbye!");
      break;
    }

    switch (action) {
      case "add":
        await addProvider();
        break;
      case "modify":
        await modifyProviderMenu();
        break;
      case "list":
        await listProviders();
        break;
    }
  }
}

async function main() {
  intro("🔧 Zed OpenAI-Compatible Provider Manager");
  await mainMenu();
}

main().catch(console.error);
