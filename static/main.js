const {
    createModalController,
    escapeAttribute,
    escapeHtml,
    formatLongDate,
    formatShortDate,
    jsonApi,
} = window.MyPyShared;

const sidebarStateKey = "mypy-main-folder-state";
const blockVariantStateKey = "mypy-main-block-variant-state";
const modal = createModalController();

const state = {
    folders: [],
    currentBlock: null,
    selectedBlockId: null,
    selectedFolderId: null,
    mode: "welcome",
    createParentBlockId: null,
    console: {
        stdout: "",
        stderr: "",
    },
    search: {
        mode: "none",
        query: "",
        results: [],
        showAll: false,
    },
};

const folderList = document.getElementById("folder-list");
const mainContent = document.getElementById("main-content");
const createFolderButton = document.getElementById("create-folder-button");
const blockSearchInput = document.getElementById("block-search-input");
const blockSearchButton = document.getElementById("block-search-button");
const recentBlocksButton = document.getElementById("recent-blocks-button");
const blockSearchResults = document.getElementById("block-search-results");
const isFileProtocol = window.location.protocol === "file:";
let activeDropFolder = null;
let draggingBlock = null;

document.addEventListener("DOMContentLoaded", () => {
    modal.ensureRoot();
    bindEvents();
    applyInitialSelectionFromUrl();
    if (isFileProtocol) {
        renderLocalFileMode();
        return;
    }
    loadFolders();
});

function bindEvents() {
    createFolderButton.addEventListener("click", handleCreateFolder);
    folderList.addEventListener("click", handleSidebarClick);
    folderList.addEventListener("dragstart", handleSidebarDragStart);
    folderList.addEventListener("dragover", handleSidebarDragOver);
    folderList.addEventListener("drop", handleSidebarDrop);
    folderList.addEventListener("dragend", resetDragState);
    blockSearchButton.addEventListener("click", handleBlockSearchSubmit);
    recentBlocksButton.addEventListener("click", handleRecentBlocksClick);
    blockSearchInput.addEventListener("keydown", handleBlockSearchInputKeyDown);
    blockSearchResults.addEventListener("click", handleBlockSearchResultsClick);
}

async function api(path, options = {}) {
    return jsonApi(
        path,
        options,
        "Run python3 app.py and open http://localhost:5000. Direct file access cannot reach the API."
    );
}

function parsePositiveInteger(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return null;
    }
    return parsed;
}

function applyInitialSelectionFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const blockId = parsePositiveInteger(params.get("blockId"));
    if (blockId) {
        state.selectedBlockId = blockId;
    }
}

function syncBlockIdInUrl(blockId) {
    const url = new URL(window.location.href);
    const normalized = parsePositiveInteger(blockId);

    if (normalized) {
        url.searchParams.set("blockId", String(normalized));
    } else {
        url.searchParams.delete("blockId");
    }

    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function splitSearchTerms(query) {
    return String(query || "")
        .toLowerCase()
        .match(/[a-z0-9_]+/g) || [];
}

function countMatches(text, term) {
    if (!text || !term) {
        return 0;
    }

    const source = String(text).toLowerCase();
    const needle = String(term).toLowerCase();
    let count = 0;
    let index = 0;

    while (index < source.length) {
        const next = source.indexOf(needle, index);
        if (next === -1) {
            break;
        }
        count += 1;
        index = next + needle.length;
    }

    return count;
}

function compareIsoDateDescending(left, right) {
    return new Date(right || 0).getTime() - new Date(left || 0).getTime();
}

function flattenBlockEntries() {
    const entries = [];

    for (const folder of state.folders) {
        for (const block of folder.blocks) {
            entries.push({
                id: block.id,
                folder_id: folder.id,
                folder_name: folder.name,
                name: block.name,
                description: block.description,
                type_test: block.type_test,
                code: block.code,
                parent_name: null,
                created_at: block.created_at,
                updated_at: block.updated_at,
            });

            for (const variant of block.variants) {
                entries.push({
                    id: variant.id,
                    folder_id: folder.id,
                    folder_name: folder.name,
                    name: variant.name,
                    description: variant.description,
                    type_test: variant.type_test,
                    code: variant.code,
                    parent_name: block.name,
                    created_at: variant.created_at,
                    updated_at: variant.updated_at,
                });
            }
        }
    }

    return entries;
}

function scoreBlockEntry(entry, rawQuery) {
    const query = String(rawQuery || "").trim().toLowerCase();
    const terms = splitSearchTerms(query);
    if (!terms.length) {
        return 0;
    }

    const name = String(entry.name || "").toLowerCase();
    const description = String(entry.description || "").toLowerCase();
    const typeTest = String(entry.type_test || "").toLowerCase();
    const code = String(entry.code || "").toLowerCase();
    let score = 0;

    for (const term of terms) {
        const nameMatches = countMatches(name, term);
        const descriptionMatches = countMatches(description, term);
        const typeMatches = countMatches(typeTest, term);
        const codeMatches = countMatches(code, term);

        if (nameMatches) {
            score += nameMatches * 18;
            score += 10;
        }
        if (descriptionMatches) {
            score += descriptionMatches * 8;
        }
        if (typeMatches) {
            score += typeMatches * 7;
        }
        if (codeMatches) {
            score += codeMatches * 3;
        }
    }

    if (query && name.includes(query)) {
        score += 16;
    }

    return score;
}

function searchBlocks(query) {
    return flattenBlockEntries()
        .map((entry) => ({
            ...entry,
            score: scoreBlockEntry(entry, query),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return compareIsoDateDescending(left.updated_at, right.updated_at);
        });
}

function recentBlocks() {
    return flattenBlockEntries().sort((left, right) => compareIsoDateDescending(left.created_at, right.created_at));
}

function refreshBlockSearchResults() {
    if (state.search.mode === "query") {
        state.search.results = searchBlocks(state.search.query);
    } else if (state.search.mode === "recent") {
        state.search.results = recentBlocks();
    } else {
        state.search.results = [];
    }

    renderBlockSearchResults();
}

function renderBlockSearchResults() {
    if (state.search.mode === "none") {
        blockSearchButton.classList.remove("is-active");
        recentBlocksButton.classList.remove("is-active");
        blockSearchResults.hidden = true;
        blockSearchResults.innerHTML = "";
        return;
    }

    blockSearchButton.classList.toggle("is-active", state.search.mode === "query");
    recentBlocksButton.classList.toggle("is-active", state.search.mode === "recent");

    const allResults = state.search.results;
    const visibleResults = state.search.showAll ? allResults : allResults.slice(0, 10);
    const modeLabel = state.search.mode === "query" ? `Search: "${escapeHtml(state.search.query)}"` : "Recent code blocks";

    blockSearchResults.hidden = false;
    blockSearchResults.innerHTML = `
        <div class="search-results-header">
            <span>${modeLabel}</span>
            <span>${allResults.length} result${allResults.length === 1 ? "" : "s"}</span>
        </div>
        ${
            visibleResults.length
                ? visibleResults
                      .map(
                          (entry) => `
                            <article class="search-result-item">
                                <div class="search-result-main">
                                    <button class="button search-result-title" data-action="search-select-block" data-block-id="${entry.id}" data-folder-id="${entry.folder_id}">
                                        ${escapeHtml(entry.name)}
                                    </button>
                                    <div class="search-result-meta">
                                        <span>${escapeHtml(entry.folder_name)}${entry.parent_name ? ` / ${escapeHtml(entry.parent_name)}` : ""}</span>
                                        <span>Created ${formatShortDate(entry.created_at)}</span>
                                    </div>
                                </div>
                                <span class="search-result-score">
                                    ${state.search.mode === "query" ? `${entry.score} pts` : formatShortDate(entry.created_at)}
                                </span>
                            </article>
                        `
                      )
                      .join("")
                : `<div class="search-empty">No matching code blocks found.</div>`
        }
        ${
            allResults.length > 10
                ? `
                    <button class="button small" data-action="toggle-search-view" type="button">
                        ${state.search.showAll ? "Show Top 10" : "View Remaining Results"}
                    </button>
                `
                : ""
        }
    `;
}

function renderLocalFileMode() {
    createFolderButton.disabled = true;
    blockSearchInput.disabled = true;
    blockSearchButton.disabled = true;
    recentBlocksButton.disabled = true;
    blockSearchResults.hidden = true;
    folderList.innerHTML = `
        <div class="empty-state">
            <h2>Server Required</h2>
            <p>The layout loads locally now, but the SQLite workspace needs the Python server.</p>
        </div>
    `;
    mainContent.innerHTML = `
        <section class="empty-state">
            <h2>Open The App Through HTTP</h2>
            <p>Run <strong>python3 app.py</strong> in this folder, then open <strong>http://localhost:5000</strong>.</p>
            <p>Opening <strong>index.html</strong> directly will not connect to the backend routes.</p>
        </section>
    `;
}

function promptForFolderName(title, defaultValue = "") {
    return modal.show({
        title,
        message: "Use a short name that will be easy to scan in the sidebar.",
        confirmLabel: defaultValue ? "Save" : "Create",
        inputLabel: "Folder name",
        defaultValue,
        placeholder: "Examples: Scripts, Ideas, Tests",
    });
}

function confirmAction(title, message) {
    return modal.show({
        title,
        message,
        confirmLabel: "Delete",
        cancelLabel: "Keep",
        destructive: true,
    });
}

function showError(message) {
    return modal.show({
        title: "Request Failed",
        message,
        confirmLabel: "Close",
        allowCancel: false,
    });
}

function normalizeBlock(block, includeVariants = true) {
    if (!block || typeof block !== "object") {
        return {
            id: null,
            folder_id: null,
            parent_block_id: null,
            parent_name: null,
            name: "",
            description: "",
            type_test: "",
            code: "",
            created_at: "",
            updated_at: "",
            variants: [],
        };
    }

    return {
        ...block,
        parent_block_id: block.parent_block_id ?? null,
        parent_name: block.parent_name ?? null,
        variants: includeVariants && Array.isArray(block.variants)
            ? block.variants.map((variant) => normalizeBlock(variant, false))
            : [],
    };
}

function normalizeFolder(folder) {
    return {
        ...folder,
        blocks: Array.isArray(folder?.blocks) ? folder.blocks.map((block) => normalizeBlock(block)) : [],
    };
}

function getExpandedFolderState() {
    try {
        return JSON.parse(localStorage.getItem(sidebarStateKey) || "{}");
    } catch {
        return {};
    }
}

function setExpandedFolderState(nextState) {
    localStorage.setItem(sidebarStateKey, JSON.stringify(nextState));
}

function isFolderExpanded(folderId) {
    const expandedState = getExpandedFolderState();
    return expandedState[String(folderId)] !== false;
}

function toggleFolderExpanded(folderId) {
    const expandedState = getExpandedFolderState();
    const current = isFolderExpanded(folderId);
    expandedState[String(folderId)] = !current;
    setExpandedFolderState(expandedState);
    renderSidebar();
}

function getExpandedVariantState() {
    try {
        return JSON.parse(localStorage.getItem(blockVariantStateKey) || "{}");
    } catch {
        return {};
    }
}

function setExpandedVariantState(nextState) {
    localStorage.setItem(blockVariantStateKey, JSON.stringify(nextState));
}

function isVariantListExpanded(block) {
    if (block.variants.some((variant) => variant.id === state.selectedBlockId)) {
        return true;
    }

    const expandedState = getExpandedVariantState();
    return expandedState[String(block.id)] === true;
}

function toggleVariantExpanded(blockId) {
    const expandedState = getExpandedVariantState();
    expandedState[String(blockId)] = !expandedState[String(blockId)];
    setExpandedVariantState(expandedState);
    renderSidebar();
}

function findBlockInState(blockId) {
    for (const folder of state.folders) {
        for (const block of folder.blocks) {
            if (block.id === blockId) {
                return { block, folder, parentBlock: null };
            }

            const variant = block.variants.find((item) => item.id === blockId);
            if (variant) {
                return { block: variant, folder, parentBlock: block };
            }
        }
    }

    return null;
}

function doesBlockExist(blockId) {
    return Boolean(findBlockInState(blockId));
}

function findFirstBlockId(folders) {
    for (const folder of folders) {
        if (folder.blocks.length > 0) {
            return folder.blocks[0].id;
        }
    }
    return null;
}

async function loadFolders() {
    try {
        const payload = await api("/folders");
        state.folders = Array.isArray(payload.folders) ? payload.folders.map(normalizeFolder) : [];

        const blockStillExists = doesBlockExist(state.selectedBlockId);
        const folderStillExists = state.folders.some((folder) => folder.id === state.selectedFolderId);
        const parentStillExists = state.createParentBlockId
            ? state.folders.some((folder) => folder.blocks.some((block) => block.id === state.createParentBlockId))
            : true;

        if (!blockStillExists) {
            state.selectedBlockId = findFirstBlockId(state.folders);
        }

        if (!folderStillExists) {
            state.selectedFolderId = state.folders[0]?.id || null;
        }

        if (!parentStillExists) {
            state.createParentBlockId = null;
        }

        refreshBlockSearchResults();

        if (state.mode === "create-block") {
            if (!state.selectedFolderId) {
                state.mode = "welcome";
                state.createParentBlockId = null;
            } else {
                renderSidebar();
                renderContent();
            }
        } else if (state.selectedBlockId) {
            state.mode = "view-block";
            await loadBlock(state.selectedBlockId);
        } else {
            state.currentBlock = null;
            state.mode = "welcome";
            syncBlockIdInUrl(null);
            renderSidebar();
            renderContent();
        }
    } catch (error) {
        renderError(error.message);
    }
}

async function loadBlock(blockId) {
    if (!blockId) {
        state.currentBlock = null;
        state.mode = "welcome";
        syncBlockIdInUrl(null);
        renderContent();
        return;
    }

    try {
        const payload = await api(`/blocks/${blockId}`);
        state.currentBlock = normalizeBlock(payload.block);
        state.selectedBlockId = state.currentBlock.id;
        state.selectedFolderId = state.currentBlock.folder_id;
        state.createParentBlockId = null;
        state.mode = "view-block";
        syncBlockIdInUrl(state.currentBlock.id);
        renderContent();
        renderSidebar();
    } catch (error) {
        renderError(error.message);
    }
}

function renderSidebar() {
    if (state.folders.length === 0) {
        folderList.innerHTML = `
            <div class="empty-state">
                <h2>No Folders</h2>
                <p>Create a folder to start storing Python blocks.</p>
            </div>
        `;
        return;
    }

    folderList.innerHTML = state.folders
        .map((folder) => {
            const expanded = isFolderExpanded(folder.id);
            return `
                <section class="folder-group" data-drop-folder-id="${folder.id}">
                    <div class="folder-header">
                        <button class="button small toggle-button" data-action="toggle-folder" data-folder-id="${folder.id}">
                            ${expanded ? "[-]" : "[+]"}
                        </button>
                        <button class="button folder-name-button ${state.selectedFolderId === folder.id ? "active" : ""}" data-action="select-folder" data-folder-id="${folder.id}">
                            ${escapeHtml(folder.name)}
                        </button>
                        <div class="folder-actions">
                            <button class="button small" data-action="new-block" data-folder-id="${folder.id}">New Block</button>
                            <button class="button small" data-action="rename-folder" data-folder-id="${folder.id}">Rename</button>
                            <button class="button small" data-action="delete-folder" data-folder-id="${folder.id}">Delete</button>
                        </div>
                    </div>
                    ${
                        expanded
                            ? `
                                <div class="folder-body">
                                    ${
                                        folder.blocks.length
                                            ? folder.blocks.map((block) => renderBlockGroup(block, folder.id)).join("")
                                            : `<div class="status-text">No code blocks in this folder. Drop one here to move it.</div>`
                                    }
                                </div>
                            `
                            : ""
                    }
                </section>
            `;
        })
        .join("");
}

function renderBlockGroup(block, folderId) {
    const variantsExpanded = isVariantListExpanded(block);
    const hasVariants = block.variants.length > 0;
    const isSelected = state.selectedBlockId === block.id;

    return `
        <div class="block-group">
            <div class="block-list-item ${isSelected ? "active" : ""}" draggable="true" data-block-id="${block.id}" data-folder-id="${folderId}">
                <div class="block-main">
                    ${
                        hasVariants
                            ? `
                                <button class="button small variant-toggle-button" data-action="toggle-variants" data-block-id="${block.id}" data-folder-id="${folderId}">
                                    ${variantsExpanded ? "v" : ">"}
                                </button>
                            `
                            : `<span class="variant-toggle-placeholder"></span>`
                    }
                    <button class="button block-name-button ${isSelected ? "active" : ""}" data-action="select-block" data-block-id="${block.id}" data-folder-id="${folderId}">
                        ${escapeHtml(block.name)}
                    </button>
                </div>
                <div class="block-side">
                    ${hasVariants ? `<span class="variant-count">${block.variants.length} variants</span>` : ""}
                    <span class="block-meta">${formatShortDate(block.updated_at)}</span>
                </div>
            </div>
            ${
                hasVariants && variantsExpanded
                    ? `
                        <div class="variant-list">
                            ${block.variants.map((variant) => renderVariantRow(variant, folderId)).join("")}
                        </div>
                    `
                    : ""
            }
        </div>
    `;
}

function renderVariantRow(variant, folderId) {
    const isSelected = state.selectedBlockId === variant.id;

    return `
        <div class="variant-list-item ${isSelected ? "active" : ""}">
            <div class="variant-main">
                <span class="variant-branch">|-</span>
                <button class="button variant-name-button ${isSelected ? "active" : ""}" data-action="select-block" data-block-id="${variant.id}" data-folder-id="${folderId}">
                    ${escapeHtml(variant.name)}
                </button>
            </div>
            <span class="block-meta">${formatShortDate(variant.updated_at)}</span>
        </div>
    `;
}

function renderContent() {
    if (state.mode === "create-block") {
        renderCreateBlockContent();
        return;
    }

    if (state.mode === "view-block" && state.currentBlock) {
        renderViewBlockContent();
        return;
    }

    const selectedFolder = state.folders.find((folder) => folder.id === state.selectedFolderId);
    const selectedFolderHasBlocks = Boolean(selectedFolder && Array.isArray(selectedFolder.blocks) && selectedFolder.blocks.length);
    const emptyStateMessage = selectedFolder
        ? selectedFolderHasBlocks
            ? "Select a code block from this folder in the sidebar, or create a new one."
            : "This folder does not contain any code blocks yet."
        : "Create a folder to begin organizing Python work.";
    mainContent.innerHTML = `
        <section class="empty-state">
            <h2>${selectedFolder ? escapeHtml(selectedFolder.name) : "Workspace"}</h2>
            <p>${emptyStateMessage}</p>
            ${
                selectedFolder
                    ? `<button id="empty-create-block-button" class="button">Create Block</button>`
                    : `<button id="empty-create-folder-button" class="button">Create Folder</button>`
            }
        </section>
    `;

    if (selectedFolder) {
        document.getElementById("empty-create-block-button").addEventListener("click", () => {
            enterCreateBlockMode(selectedFolder.id);
        });
    } else {
        document.getElementById("empty-create-folder-button").addEventListener("click", handleCreateFolder);
    }
}

function renderCreateBlockContent() {
    const folder = state.folders.find((item) => item.id === state.selectedFolderId);
    const parentLookup = state.createParentBlockId ? findBlockInState(state.createParentBlockId) : null;
    const parentBlock = parentLookup?.block || null;
    const isVariantMode = Boolean(parentBlock);

    mainContent.innerHTML = `
        <section class="editor-panel">
            <h2>${isVariantMode ? "Create Variant" : "Create Code Block"}</h2>
            <p>
                ${
                    isVariantMode
                        ? `Create a subsection under <strong>${escapeHtml(parentBlock.name)}</strong> in <strong>${escapeHtml(folder?.name || "Selected Folder")}</strong>.`
                        : `Create a Python project inside <strong>${escapeHtml(folder?.name || "Selected Folder")}</strong>.`
                }
            </p>
            <form id="block-editor-form">
                ${
                    isVariantMode
                        ? `
                            <div class="meta-row">
                                <span>Parent Block: ${escapeHtml(parentBlock.name)}</span>
                                <span>Folder: ${escapeHtml(folder?.name || "Selected Folder")}</span>
                            </div>
                        `
                        : ""
                }
                <div class="field-grid">
                    <label class="field-group">
                        <span>Name</span>
                        <input name="name" required>
                    </label>
                    <label class="field-group">
                        <span>test</span>
                        <input name="type_test" required>
                    </label>
                </div>
                <label class="field-group">
                    <span>Description</span>
                    <textarea name="description" required rows="4"></textarea>
                </label>
                <label class="field-group">
                    <span>Python Code</span>
                    <textarea class="code-area" name="code" rows="18"></textarea>
                </label>
                ${isVariantMode ? "" : renderVariantBuilderSection()}
                <div class="editor-actions">
                    <button class="button" type="submit">${isVariantMode ? "Save Variant" : "Save Block"}</button>
                    <button id="cancel-create-button" class="button" type="button">Cancel</button>
                </div>
            </form>
        </section>
    `;

    bindCreateBlockForm();
}

function renderVariantBuilderSection() {
    return `
        <section class="variant-builder">
            <div class="section-header">
                <div>
                    <h3>Variants</h3>
                    <p>Optional subsections for alternate versions of this code block.</p>
                </div>
                <button id="add-variant-draft-button" class="button button-muted" type="button">Add Variant</button>
            </div>
            <div id="variant-draft-list" class="variant-draft-list">
                <div class="variant-empty-state">No variants yet. Add one if this block needs alternate versions.</div>
            </div>
        </section>
    `;
}

function bindCreateBlockForm() {
    document.getElementById("block-editor-form").addEventListener("submit", handleCreateBlockSubmit);
    document.getElementById("cancel-create-button").addEventListener("click", cancelCreateMode);

    const addVariantButton = document.getElementById("add-variant-draft-button");
    if (!addVariantButton) {
        return;
    }

    addVariantButton.addEventListener("click", () => addVariantDraftCard());
}

function addVariantDraftCard(initialValues = {}) {
    const variantList = document.getElementById("variant-draft-list");
    if (!variantList) {
        return;
    }

    variantList.querySelector(".variant-empty-state")?.remove();
    const card = document.createElement("article");
    card.className = "variant-draft-card";
    card.innerHTML = `
        <div class="variant-draft-header">
            <strong>Variant</strong>
            <button class="button small button-muted" type="button">Remove</button>
        </div>
        <div class="field-grid">
            <label class="field-group">
                <span>Name</span>
                <input class="variant-name-input" value="${escapeAttribute(initialValues.name || "")}">
            </label>
            <label class="field-group">
                <span>test</span>
                <input class="variant-test-input" value="${escapeAttribute(initialValues.type_test || "")}">
            </label>
        </div>
        <label class="field-group">
            <span>Description</span>
            <textarea class="variant-description-input" rows="3">${escapeHtml(initialValues.description || "")}</textarea>
        </label>
        <label class="field-group">
            <span>Variant Code</span>
            <textarea class="code-area compact-code-area variant-code-input" rows="10">${escapeHtml(initialValues.code || "")}</textarea>
        </label>
    `;

    card.querySelector("button").addEventListener("click", () => {
        card.remove();
        ensureVariantDraftEmptyState();
    });

    variantList.append(card);
}

function ensureVariantDraftEmptyState() {
    const variantList = document.getElementById("variant-draft-list");
    if (!variantList || variantList.children.length > 0) {
        return;
    }

    variantList.innerHTML = `<div class="variant-empty-state">No variants yet. Add one if this block needs alternate versions.</div>`;
}

function collectVariantPayloads(form) {
    const variants = [];
    const cards = form.querySelectorAll(".variant-draft-card");

    for (const card of cards) {
        const name = card.querySelector(".variant-name-input").value.trim();
        const description = card.querySelector(".variant-description-input").value.trim();
        const typeTest = card.querySelector(".variant-test-input").value.trim();
        const code = card.querySelector(".variant-code-input").value;
        const hasAnyValue = name || description || typeTest || code.trim();

        if (!hasAnyValue) {
            continue;
        }

        if (!name || !description || !typeTest) {
            throw new Error("Each variant needs a name, description, and test label.");
        }

        variants.push({
            name,
            description,
            type_test: typeTest,
            code,
        });
    }

    return variants;
}

function renderViewBlockContent() {
    const currentFolder = state.folders.find((folder) => folder.id === state.currentBlock.folder_id);
    const parentLookup = state.currentBlock.parent_block_id ? findBlockInState(state.currentBlock.parent_block_id) : null;
    const parentBlock = parentLookup?.block || null;
    const isVariant = Boolean(state.currentBlock.parent_block_id);

    mainContent.innerHTML = `
        <section class="editor-panel">
            <h2>${escapeHtml(state.currentBlock.name)}</h2>
            <p class="context-note">
                ${
                    isVariant
                        ? `This is a variant under <strong>${escapeHtml(state.currentBlock.parent_name || parentBlock?.name || "Parent Block")}</strong>.`
                        : state.currentBlock.variants.length
                          ? `This block has ${state.currentBlock.variants.length} variant${state.currentBlock.variants.length === 1 ? "" : "s"} available from the sidebar dropdown.`
                          : "This block does not have variants yet."
                }
            </p>
            <form id="block-editor-form">
                <div class="meta-row">
                    <span>Created: ${formatLongDate(state.currentBlock.created_at)}</span>
                    <span>Updated: ${formatLongDate(state.currentBlock.updated_at)}</span>
                    ${
                        isVariant
                            ? `<span>Parent: ${escapeHtml(state.currentBlock.parent_name || parentBlock?.name || "Parent Block")}</span>`
                            : `<span>Variants: ${state.currentBlock.variants.length}</span>`
                    }
                </div>
                <div class="field-grid">
                    <label class="field-group">
                        <span>Name</span>
                        <input name="name" value="${escapeAttribute(state.currentBlock.name)}" required>
                    </label>
                    ${
                        isVariant
                            ? `
                                <input type="hidden" name="folder_id" value="${state.currentBlock.folder_id}">
                                <label class="field-group">
                                    <span>Folder</span>
                                    <input value="${escapeAttribute(currentFolder?.name || "")}" disabled>
                                </label>
                                <label class="field-group">
                                    <span>Parent Block</span>
                                    <input value="${escapeAttribute(state.currentBlock.parent_name || parentBlock?.name || "")}" disabled>
                                </label>
                            `
                            : `
                                <label class="field-group">
                                    <span>Folder</span>
                                    <select name="folder_id">
                                        ${state.folders
                                            .map(
                                                (folder) => `
                                                    <option value="${folder.id}" ${folder.id === state.currentBlock.folder_id ? "selected" : ""}>
                                                        ${escapeHtml(folder.name)}
                                                    </option>
                                                `
                                            )
                                            .join("")}
                                    </select>
                                </label>
                            `
                    }
                </div>
                <label class="field-group">
                    <span>Description</span>
                    <textarea name="description" required rows="4">${escapeHtml(state.currentBlock.description)}</textarea>
                </label>
                <label class="field-group">
                    <span>test</span>
                    <input name="type_test" value="${escapeAttribute(state.currentBlock.type_test)}" required>
                </label>
                <label class="field-group">
                    <span>Python Code</span>
                    <textarea class="code-area" name="code" rows="18">${escapeHtml(state.currentBlock.code)}</textarea>
                </label>
                <div class="editor-actions">
                    <button class="button" type="submit">Save Changes</button>
                    <button id="run-block-button" class="button" type="button">Run</button>
                    ${isVariant ? "" : `<button id="add-variant-button" class="button button-muted" type="button">Add Variant</button>`}
                    <button id="delete-block-button" class="button" type="button">Delete ${isVariant ? "Variant" : "Block"}</button>
                </div>
            </form>
        </section>
        <section class="console-panel">
            <h3>Output Console</h3>
            <div class="console-sections">
                <div class="console-block">
                    <h4>stdout</h4>
                    <pre class="console-output">${escapeHtml(state.console.stdout || "")}</pre>
                </div>
                <div class="console-block">
                    <h4>stderr</h4>
                    <pre class="console-output">${escapeHtml(state.console.stderr || "")}</pre>
                </div>
            </div>
        </section>
    `;

    document.getElementById("block-editor-form").addEventListener("submit", handleSaveBlockSubmit);
    document.getElementById("run-block-button").addEventListener("click", handleRunBlock);
    document.getElementById("delete-block-button").addEventListener("click", handleDeleteBlock);
    document.getElementById("add-variant-button")?.addEventListener("click", handleCreateVariant);
}

function renderError(message) {
    mainContent.innerHTML = `
        <section class="empty-state">
            <h2>Request Failed</h2>
            <p>${escapeHtml(message)}</p>
        </section>
    `;
}

function enterCreateBlockMode(folderId, parentBlockId = null) {
    state.selectedFolderId = Number(folderId);
    state.createParentBlockId = parentBlockId ? Number(parentBlockId) : null;
    state.mode = "create-block";
    state.console = { stdout: "", stderr: "" };
    renderSidebar();
    renderContent();
}

function cancelCreateMode() {
    state.createParentBlockId = null;
    if (state.selectedBlockId) {
        state.mode = "view-block";
        renderContent();
        return;
    }
    state.mode = "welcome";
    renderContent();
}

function handleBlockSearchSubmit() {
    const query = blockSearchInput.value.trim();

    if (!query) {
        state.search = {
            mode: "none",
            query: "",
            results: [],
            showAll: false,
        };
        renderBlockSearchResults();
        return;
    }

    state.search = {
        mode: "query",
        query,
        results: [],
        showAll: false,
    };
    refreshBlockSearchResults();
}

function handleRecentBlocksClick() {
    state.search = {
        mode: "recent",
        query: "",
        results: [],
        showAll: false,
    };
    refreshBlockSearchResults();
}

function handleBlockSearchInputKeyDown(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        handleBlockSearchSubmit();
        return;
    }

    if (event.key === "Escape" && state.search.mode !== "none") {
        event.preventDefault();
        blockSearchInput.value = "";
        state.search = {
            mode: "none",
            query: "",
            results: [],
            showAll: false,
        };
        renderBlockSearchResults();
    }
}

async function handleBlockSearchResultsClick(event) {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) {
        return;
    }

    const { action, blockId, folderId } = actionTarget.dataset;

    if (action === "toggle-search-view") {
        state.search.showAll = !state.search.showAll;
        renderBlockSearchResults();
        return;
    }

    if (action === "search-select-block") {
        state.selectedFolderId = Number(folderId);
        state.console = { stdout: "", stderr: "" };
        await loadBlock(Number(blockId));
    }
}

async function handleCreateFolder() {
    const name = await promptForFolderName("Create Folder");
    if (!name) {
        return;
    }

    try {
        const payload = await api("/folders", {
            method: "POST",
            body: JSON.stringify({ name }),
        });
        state.selectedFolderId = payload.folder.id;
        const expandedState = getExpandedFolderState();
        expandedState[String(payload.folder.id)] = true;
        setExpandedFolderState(expandedState);
        await loadFolders();
    } catch (error) {
        await showError(error.message);
    }
}

async function handleSidebarClick(event) {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) {
        return;
    }

    const { action, folderId, blockId } = actionTarget.dataset;

    if (action === "toggle-folder") {
        toggleFolderExpanded(Number(folderId));
        return;
    }

    if (action === "toggle-variants") {
        toggleVariantExpanded(Number(blockId));
        return;
    }

    if (action === "select-folder") {
        state.selectedFolderId = Number(folderId);
        state.selectedBlockId = null;
        state.currentBlock = null;
        state.createParentBlockId = null;
        state.mode = "welcome";
        syncBlockIdInUrl(null);
        renderSidebar();
        renderContent();
        return;
    }

    if (action === "new-block") {
        enterCreateBlockMode(Number(folderId));
        return;
    }

    if (action === "rename-folder") {
        const folder = state.folders.find((item) => item.id === Number(folderId));
        const nextName = await promptForFolderName("Rename Folder", folder?.name || "");
        if (!nextName) {
            return;
        }

        try {
            await api(`/folders/${folderId}`, {
                method: "PUT",
                body: JSON.stringify({ name: nextName }),
            });
            await loadFolders();
        } catch (error) {
            await showError(error.message);
        }
        return;
    }

    if (action === "delete-folder") {
        const confirmed = await confirmAction("Delete Folder", "Delete this folder and every code block inside it?");
        if (!confirmed) {
            return;
        }

        try {
            await api(`/folders/${folderId}`, { method: "DELETE" });
            if (Number(folderId) === state.selectedFolderId) {
                state.selectedFolderId = null;
                state.selectedBlockId = null;
                state.currentBlock = null;
                state.createParentBlockId = null;
                state.mode = "welcome";
            }
            await loadFolders();
        } catch (error) {
            await showError(error.message);
        }
        return;
    }

    if (action === "select-block") {
        state.selectedFolderId = Number(folderId);
        state.console = { stdout: "", stderr: "" };
        await loadBlock(Number(blockId));
    }
}

async function handleCreateBlockSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    let variants = [];
    try {
        variants = collectVariantPayloads(event.currentTarget);
    } catch (error) {
        await showError(error.message);
        return;
    }

    const payload = {
        folder_id: state.selectedFolderId,
        parent_block_id: state.createParentBlockId,
        name: formData.get("name"),
        description: formData.get("description"),
        type_test: formData.get("type_test"),
        code: formData.get("code"),
        variants,
    };

    try {
        const response = await api("/blocks", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        state.currentBlock = normalizeBlock(response.block);
        state.selectedBlockId = state.currentBlock.id;
        state.mode = "view-block";
        state.createParentBlockId = null;
        state.console = { stdout: "", stderr: "" };

        if (state.currentBlock.parent_block_id) {
            const expandedVariants = getExpandedVariantState();
            expandedVariants[String(state.currentBlock.parent_block_id)] = true;
            setExpandedVariantState(expandedVariants);
        }

        await loadFolders();
    } catch (error) {
        await showError(error.message);
    }
}

async function handleSaveBlockSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
        folder_id: Number(formData.get("folder_id")),
        parent_block_id: state.currentBlock.parent_block_id ?? null,
        name: formData.get("name"),
        description: formData.get("description"),
        type_test: formData.get("type_test"),
        code: formData.get("code"),
    };

    try {
        const response = await api(`/blocks/${state.currentBlock.id}`, {
            method: "PUT",
            body: JSON.stringify(payload),
        });
        state.currentBlock = normalizeBlock(response.block);
        state.selectedBlockId = state.currentBlock.id;
        state.selectedFolderId = state.currentBlock.folder_id;
        await loadFolders();
    } catch (error) {
        await showError(error.message);
    }
}

async function handleRunBlock() {
    const form = document.getElementById("block-editor-form");
    const formData = new FormData(form);
    const code = formData.get("code");

    try {
        const payload = await api("/run", {
            method: "POST",
            body: JSON.stringify({ code }),
        });
        state.console = payload;
        renderContent();
    } catch (error) {
        state.console = { stdout: "", stderr: error.message };
        renderContent();
    }
}

function handleCreateVariant() {
    if (!state.currentBlock || state.currentBlock.parent_block_id) {
        return;
    }

    enterCreateBlockMode(state.currentBlock.folder_id, state.currentBlock.id);
}

async function handleDeleteBlock() {
    if (!state.currentBlock) {
        return;
    }

    const isVariant = Boolean(state.currentBlock.parent_block_id);
    const hasVariants = !isVariant && state.currentBlock.variants.length > 0;
    const message = isVariant
        ? "Delete this variant?"
        : hasVariants
          ? "Delete this code block and all of its variants?"
          : "Delete this code block?";
    const confirmed = await confirmAction(`Delete ${isVariant ? "Variant" : "Code Block"}`, message);
    if (!confirmed) {
        return;
    }

    try {
        await api(`/blocks/${state.currentBlock.id}`, { method: "DELETE" });
        state.currentBlock = null;
        state.selectedBlockId = null;
        state.mode = "welcome";
        state.console = { stdout: "", stderr: "" };
        await loadFolders();
    } catch (error) {
        await showError(error.message);
    }
}

function handleSidebarDragStart(event) {
    const blockElement = event.target.closest(".block-list-item[draggable='true']");
    if (!blockElement) {
        return;
    }

    draggingBlock = {
        id: Number(blockElement.dataset.blockId),
        folderId: Number(blockElement.dataset.folderId),
    };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(draggingBlock.id));
    blockElement.classList.add("dragging");
}

function handleSidebarDragOver(event) {
    if (!draggingBlock) {
        return;
    }

    const folderElement = event.target.closest(".folder-group[data-drop-folder-id]");
    if (!folderElement) {
        clearDropTarget();
        return;
    }

    const targetFolderId = Number(folderElement.dataset.dropFolderId);
    if (targetFolderId === draggingBlock.folderId) {
        clearDropTarget();
        return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(folderElement);
}

async function handleSidebarDrop(event) {
    if (!draggingBlock) {
        return;
    }

    const folderElement = event.target.closest(".folder-group[data-drop-folder-id]");
    clearDropTarget();
    if (!folderElement) {
        resetDragState();
        return;
    }

    event.preventDefault();
    const targetFolderId = Number(folderElement.dataset.dropFolderId);
    const { id: blockId, folderId: sourceFolderId } = draggingBlock;
    resetDragState();

    if (targetFolderId === sourceFolderId) {
        return;
    }

    await moveBlockToFolder(blockId, targetFolderId);
}

function setDropTarget(folderElement) {
    if (activeDropFolder === folderElement) {
        return;
    }

    clearDropTarget();
    activeDropFolder = folderElement;
    activeDropFolder.classList.add("drop-target");
}

function clearDropTarget() {
    if (!activeDropFolder) {
        return;
    }

    activeDropFolder.classList.remove("drop-target");
    activeDropFolder = null;
}

function resetDragState() {
    folderList.querySelectorAll(".block-list-item.dragging").forEach((element) => {
        element.classList.remove("dragging");
    });
    draggingBlock = null;
    clearDropTarget();
}

async function moveBlockToFolder(blockId, targetFolderId) {
    try {
        const payload = await api(`/blocks/${blockId}`);
        const block = normalizeBlock(payload.block, false);
        await api(`/blocks/${blockId}`, {
            method: "PUT",
            body: JSON.stringify({
                folder_id: targetFolderId,
                parent_block_id: block.parent_block_id,
                name: block.name,
                description: block.description,
                type_test: block.type_test,
                code: block.code,
            }),
        });

        const expandedState = getExpandedFolderState();
        expandedState[String(targetFolderId)] = true;
        setExpandedFolderState(expandedState);
        state.selectedFolderId = targetFolderId;
        state.selectedBlockId = blockId;
        await loadFolders();
    } catch (error) {
        await showError(error.message);
    }
}
