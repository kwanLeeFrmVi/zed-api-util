import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as jsonc from "jsonc-parser";
import { confirm, select, multiselect, text, spinner, note, intro, outro } from "@clack/prompts";

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

async function fetchModels(
  endpoint: string,
  apiKey?: string
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
        console.error(
          `\n⚠️  Authentication required but no API key found.\n` +
            `Please set your API key in ~/.zshrc or ~/.bashrc:\n\n` +
            `  export ${deriveEnvVarName("<PROVIDER_NAME>")}="your-api-key-here"\n`
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

    return models;
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

async function upsertProvider() {
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
  const apiKey = process.env[envVarName];

  console.log(`\n📝 Provider: ${providerName}`);
  console.log(`🔗 API URL: ${normalizedApiUrl}`);
  console.log(`🔑 API Key: ${apiKey ? "✓ Found in env" : "✗ Not set"}\n`);

  if (!apiKey) {
    note(
      `Set your API key:\n\n` +
      `  export ${envVarName}="your-api-key-here"\n\n` +
      `Add this to ~/.zshrc or ~/.bashrc to persist.`,
      "💡 Optional API Key"
    );
  }

  // Fetch models
  const models = await fetchModels(modelsEndpoint, apiKey);
  console.log(`\n✓ Found ${models.length} models\n`);

  // Select models
  const selectionMode = await select({
    message: "How do you want to select models?",
    options: [
      { value: "interactive", label: "Interactive selection (pick specific models)" },
      { value: "all", label: "Add all models" },
    ],
  });

  if (typeof selectionMode === "symbol") {
    return;
  }

  let selectedModelIds: string[];

  if (selectionMode === "all") {
    selectedModelIds = models.map((m) => m.id);
    console.log(`\n✓ Selected all ${selectedModelIds.length} models`);
  } else {
    const choices = models.map((m) => ({
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

  // Ask for default max_tokens for new models
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

  const defaultMaxTokens = parseInt(maxTokensInput as string, 10) || 8192;

  // Read existing settings
  const { text: settingsText, data: settings } = readZedSettings();

  // Get existing provider config (if any)
  const existingProvider: Provider | undefined =
    settings?.language_models?.openai_compatible?.[providerName as string];

  const existingModelsMap = new Map<string, AvailableModel>();
  if (existingProvider?.available_models) {
    for (const model of existingProvider.available_models) {
      existingModelsMap.set(model.name, model);
    }
  }

  // Build new available_models array
  const availableModels: AvailableModel[] = selectedModelIds.map((modelId) => {
    const existing = existingModelsMap.get(modelId);
    if (existing) {
      return existing;
    } else {
      return {
        name: modelId,
        display_name: deriveDisplayName(modelId),
        max_tokens: defaultMaxTokens,
        capabilities: {
          tools: true,
          images: false,
          parallel_tool_calls: false,
          prompt_cache_key: false,
        },
      };
    }
  });

  const newProvider: Provider = {
    api_url: normalizedApiUrl,
    available_models: availableModels,
  };

  // Update settings using jsonc-parser to preserve formatting
  const path = ["language_models", "openai_compatible", providerName as string];

  // Ensure parent paths exist
  let updatedText = settingsText;

  if (!settings.language_models) {
    updatedText = jsonc.applyEdits(
      updatedText,
      jsonc.modify(updatedText, ["language_models"], {}, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    );
  }

  const settingsAfterLM = jsonc.parse(updatedText);
  if (!settingsAfterLM.language_models.openai_compatible) {
    updatedText = jsonc.applyEdits(
      updatedText,
      jsonc.modify(updatedText, ["language_models", "openai_compatible"], {}, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    );
  }

  // Now set the provider
  const edits = jsonc.modify(updatedText, path, newProvider, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });

  updatedText = jsonc.applyEdits(updatedText, edits);

  // Write back
  writeZedSettings(updatedText);

  console.log(`\n✅ Successfully configured provider "${providerName}" with ${availableModels.length} models!`);

  if (!apiKey) {
    console.log(`\n💡 To use this provider, add to your shell rc file:\n`);
    console.log(`   export ${envVarName}="your-api-key-here"\n`);
  }
}

async function listProviders() {
  const { data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n📭 No providers configured\n");
    console.log("💡 Use 'Create/Update provider' to add your first provider\n");
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

async function editModelSettings() {
  const { text: settingsText, data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n⚠️  No providers configured. Create a provider first.\n");
    return;
  }

  // Step 1: Select provider
  const providerName = await select({
    message: "Select provider to edit:",
    options: providerNames.map(name => ({
      value: name,
      label: name,
      hint: `${providers[name].available_models?.length || 0} models`,
    })),
  });

  if (typeof providerName === "symbol") {
    return;
  }

  const provider = providers[providerName as string];
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
      const modelIndex = models.findIndex((m: AvailableModel) => m.name === modelName);
      const path = [
        "language_models",
        "openai_compatible",
        providerName as string,
        "available_models",
        modelIndex,
        "max_tokens",
      ];

      const edits = jsonc.modify(updatedText, path, tokenValue, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      updatedText = jsonc.applyEdits(updatedText, edits);
    }

    console.log(`\n✅ Updated max_tokens to ${tokenValue} for ${modelNames.length} model(s)\n`);
  } else {
    // Capability toggle
    const currentValue = models.find((m: AvailableModel) => m.name === modelNames[0])
      ?.capabilities?.[editAction as keyof AvailableModel['capabilities']];

    const newValue = await confirm({
      message: `Enable ${editAction}?`,
      initialValue: currentValue ?? false,
    });

    if (typeof newValue === "symbol") {
      return;
    }

    for (const modelName of modelNames) {
      const modelIndex = models.findIndex((m: AvailableModel) => m.name === modelName);
      const path = [
        "language_models",
        "openai_compatible",
        providerName as string,
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

    console.log(`\n✅ Set ${editAction} to ${newValue} for ${modelNames.length} model(s)\n`);
  }

  writeZedSettings(updatedText);
}

async function deleteProvider() {
  const { text: settingsText, data: settings } = readZedSettings();
  const providers = settings?.language_models?.openai_compatible || {};
  const providerNames = Object.keys(providers);

  if (providerNames.length === 0) {
    console.log("\n📭 No providers to delete\n");
    return;
  }

  // Step 1: Select provider
  const providerName = await select({
    message: "Select provider to delete:",
    options: providerNames.map(name => ({
      value: name,
      label: name,
      hint: `${providers[name].available_models?.length || 0} models`,
    })),
  });

  if (typeof providerName === "symbol") {
    return;
  }

  const provider = providers[providerName as string];
  const modelCount = provider.available_models?.length || 0;

  // Step 2: Confirm deletion
  const confirmed = await confirm({
    message: `Delete provider "${providerName}" with ${modelCount} model(s)?`,
    initialValue: false,
  });

  if (typeof confirmed === "symbol" || !confirmed) {
    console.log("\n❌ Deletion cancelled\n");
    return;
  }

  // Step 3: Delete using jsonc-parser
  const path = ["language_models", "openai_compatible", providerName as string];
  const edits = jsonc.modify(settingsText, path, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });

  const updatedText = jsonc.applyEdits(settingsText, edits);
  writeZedSettings(updatedText);

  console.log(`\n✅ Successfully deleted provider "${providerName}"\n`);
}

async function mainMenu() {
  while (true) {
    console.log("");
    const action = await select({
      message: "What would you like to do?",
      options: [
        { value: "upsert", label: "Create/Update provider" },
        { value: "list", label: "List all providers" },
        { value: "edit", label: "Edit model settings" },
        { value: "delete", label: "Delete provider" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (typeof action === "symbol" || action === "exit") {
      outro("👋 Goodbye!");
      break;
    }

    switch (action) {
      case "upsert":
        await upsertProvider();
        break;
      case "list":
        await listProviders();
        break;
      case "edit":
        await editModelSettings();
        break;
      case "delete":
        await deleteProvider();
        break;
    }
  }
}

async function main() {
  intro("🔧 Zed OpenAI-Compatible Provider Manager");
  await mainMenu();
}

main().catch(console.error);
