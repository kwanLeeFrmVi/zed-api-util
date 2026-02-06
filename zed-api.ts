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
  apiKey?: string,
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
            `  export ${deriveEnvVarName("<PROVIDER_NAME>")}="your-api-key-here"\n`,
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
  const apiKey = process.env[envVarName];

  console.log(`\n📝 Provider: ${providerName}`);
  console.log(`🔗 API URL: ${normalizedApiUrl}`);
  console.log(`🔑 API Key: ${apiKey ? "✓ Found in env" : "✗ Not set"}\n`);

  if (!apiKey) {
    note(
      `Set your API key:\n\n` +
        `  export ${envVarName}="your-api-key-here"\n\n` +
        `Add this to ~/.zshrc or ~/.bashrc to persist.`,
      "💡 Optional API Key",
    );
  }

  // Fetch models
  const models = await fetchModels(modelsEndpoint, apiKey);
  console.log(`\n✓ Found ${models.length} models\n`);

  // Select models
  const selectionMode = await select({
    message: "How do you want to select models?",
    options: [
      {
        value: "interactive",
        label: "Interactive selection (pick specific models)",
      },
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
  const availableModels: AvailableModel[] = selectedModelIds.map((modelId) => ({
    name: modelId,
    display_name: deriveDisplayName(modelId),
    max_tokens: defaultMaxTokens,
    capabilities: {
      tools: true,
      images: false,
      parallel_tool_calls: false,
      prompt_cache_key: false,
    },
  }));

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

  const fetchedModels = await fetchModels(modelsEndpoint, apiKey);
  console.log(`\n✓ Found ${fetchedModels.length} models from API\n`);

  // Create options with existing models pre-selected
  const choices = fetchedModels.map((m) => ({
    value: m.id,
    label: m.id,
    hint: existingModelNames.has(m.id)
      ? "✓ Currently active"
      : deriveDisplayName(m.id),
  }));

  // Pre-select existing models
  const initialSelected = fetchedModels
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

  // Calculate changes
  const additions = selectedModelIds.filter(
    (id) => !existingModelNames.has(id),
  );
  const removals = Array.from(existingModelNames).filter(
    (id: string) => !selectedSet.has(id),
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

  const availableModels: AvailableModel[] = selectedModelIds.map((modelId) => {
    const existing = existingModelsMap.get(modelId);
    if (existing) {
      // Preserve settings for existing models
      return existing;
    } else {
      // Create new model with default settings
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
